#!/usr/bin/env bash
# FULL production release of the WhatsApp AI Agent (code under src/, migrations, dashboard): run ON the Oracle server as ubuntu.
#   bash scripts/release-full.sh --base <live commit> --target <commit on origin/master> [--check-only]
# From the Windows checkout: `pwsh scripts/release-full.ps1 [-Target <commit>] [-Apply]` fills both hashes in (base = production's live HEAD, checked
# against the published stamp), stages this file and runs the rehearsal; nothing runs locally.
# When streamed over ssh, STAGE it first ("cat > /tmp/release-full.sh; bash /tmp/release-full.sh ..."): a script read by `bash -s` from stdin is cut
# short by any child that reads stdin (npm, systemctl), which twice ended a run silently after a successful restart. Children here also get </dev/null.
# Order (docs/ENVIRONMENTS_AND_RELEASES.md): guards -> verified backup (database .backup + integrity, accounts/, baileys-auth/, uploads/,
# knowledge/, .env) -> git merge --ff-only -> npm ci only if package files changed -> npm run build -> restart ONLY whatsapp-ai-agent ->
# proof (health, readiness, port 3000 once, port 3005 untouched, migrations, admin/credential/knowledge/baileys-identity fingerprints).
# Migrations run at boot by the application itself; this script never runs SQL against the live database.
# Rollback (printed on failure): git checkout --detach <base> && npm run build && sudo systemctl restart whatsapp-ai-agent; a database
# migration is additive and is NOT reverted (restore the backup only if the data itself is damaged, which this release does not touch).
set -euo pipefail
R=/home/ubuntu/whatsapp-ai-agent; D=/home/ubuntu/whatsapp-data; DB=$D/app.db; B=/home/ubuntu/whatsapp-backups; SVC=whatsapp-ai-agent; PORT=3000
BASE=""; TARGET=""; CHECK=0
while [ $# -gt 0 ]; do case "$1" in --base) BASE=$2; shift 2;; --target) TARGET=$2; shift 2;; --check-only) CHECK=1; shift;; *) echo "unknown arg $1"; exit 2;; esac; done
abort() { echo "ABORT[$1]: $2"; exit 1; }
[[ "$BASE" =~ ^[0-9a-f]{7,40}$ && "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || abort args "--base <commit production is live on> and --target <commit of origin/master> are both required and must be commit hashes. This script runs ON the server; from the Windows checkout use: pwsh scripts/release-full.ps1 [-Target <commit>] [-Apply] (it reads the base from production and stages this file)"
[ -d "$R/.git" ] || abort server "$R is not the production checkout: this script runs on the Oracle server (from Windows: pwsh scripts/release-full.ps1)"
[ "$PORT" = 3000 ] || abort port-guard "app port must be 3000"
ss -ltn | grep -q ':3005 ' && echo "note: port 3005 belongs to another project and is left alone" || true
[ "$(git -C $R remote get-url origin)" = "https://github.com/ahmedalfarooque/whatsapp-ai-agent.git" ] || abort repo "unexpected origin"
[ "$(git -C $R branch --show-current)" = master ] || abort repo "checkout is not on master"
[ -z "$(git -C $R status --porcelain --untracked-files=no)" ] || abort repo "live checkout has uncommitted changes"
HEAD=$(git -C $R rev-parse HEAD); [[ "$HEAD" == "$BASE"* ]] || abort base "live HEAD ${HEAD:0:7} != --base"
git -C $R fetch -q origin
TFULL=$(git -C $R rev-parse --verify "$TARGET^{commit}") || abort target "unknown target"
[ "$(git -C $R rev-parse origin/master)" = "$TFULL" ] || abort target "origin/master is not the target"
git -C $R merge-base --is-ancestor "$HEAD" "$TFULL" || abort target "not a fast-forward"
[ "$(systemctl is-active $SVC)" = active ] || abort service "$SVC is not active"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health)" = 200 ] || abort health "health is not 200 before the release"
[ "$(sqlite3 "file:$DB?mode=ro" 'PRAGMA integrity_check;')" = ok ] || abort database "integrity check failed before the release"
NEED=$(du -sk $D | cut -f1); FREE=$(df -k --output=avail /home/ubuntu | tail -1); [ "$FREE" -gt $((NEED * 3)) ] || abort space "not enough free space for a backup"
PKG=$(git -C $R diff --name-only "$HEAD" "$TFULL" -- package.json package-lock.json | wc -l)
MIG=$(git -C $R diff --name-only "$HEAD" "$TFULL" -- src/memory/migrations | tr '\n' ' ')
fp() { echo "admins=$(sqlite3 "file:$DB?mode=ro" 'SELECT id,username,role,password_hash FROM admin_users ORDER BY id;' | sha256sum | cut -c1-16) creds=$(sqlite3 "file:$DB?mode=ro" 'SELECT * FROM credential_overrides ORDER BY key;' | sha256sum | cut -c1-16) accounts=$(sqlite3 "file:$DB?mode=ro" 'SELECT id,name,enabled,phone_number,jid FROM whatsapp_accounts ORDER BY id;' | sha256sum | cut -c1-16) customers=$(sqlite3 "file:$DB?mode=ro" 'SELECT count(*) FROM customers;') messages=$(sqlite3 "file:$DB?mode=ro" 'SELECT count(*) FROM conversation_messages;') baileys_identity=$(for f in $D/baileys-auth/creds.json $D/accounts/*/baileys-auth/creds.json; do if [ -f "$f" ]; then python3 -c "import json;d=json.load(open('$f'));print('$f',d.get('registrationId'),(d.get('me') or {}).get('id'))"; fi; done | sha256sum | cut -c1-16) baileys_files=$(find $D -path '*baileys-auth*' -type f | wc -l) uploads=$(find $D -path '*uploads*' -type f | wc -l) knowledge=$(find $R/knowledge -type f \( -name '*.md' -o -name '*.json' \) -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)"; return 0; }
# (an unpaired account has no creds.json right after a restart; the old `[ -f ] && …` form made fp() return non-zero there and, under set -e, ended the
#  2026-10-13 release silently after the restart — the release itself was complete and was proven by hand)
BEFORE=$(fp)
echo "preconditions ok: ${HEAD:0:7} -> ${TFULL:0:7}; package files changed: $PKG; migrations added: ${MIG:-none}"
echo "fingerprints before: $BEFORE"
if [ "$CHECK" = 1 ]; then echo "CHECK-ONLY OK: nothing was written"; exit 0; fi

# ---- backup (verified)
TS=$(date -u +%Y%m%d-%H%M%S); OUT=$B/pre-full-release-$TS
sudo -n install -d -o ubuntu -g ubuntu -m 750 "$OUT" || abort backup "cannot create $OUT"
sqlite3 "file:$DB?mode=ro" ".backup $OUT/app.db"
[ "$(sqlite3 $OUT/app.db 'PRAGMA integrity_check;')" = ok ] || abort backup "backup database integrity failed"
[ "$(sqlite3 $OUT/app.db 'SELECT count(*) FROM whatsapp_accounts;')" = "$(sqlite3 "file:$DB?mode=ro" 'SELECT count(*) FROM whatsapp_accounts;')" ] || abort backup "backup account count differs"
for d in accounts baileys-auth uploads; do [ -e "$D/$d" ] && cp -a "$D/$d" "$OUT/" ; done
cp -a $R/knowledge "$OUT/knowledge"; cp -p $R/.env "$OUT/env.backup"; chmod 600 "$OUT/env.backup"
diff -rq $R/knowledge "$OUT/knowledge" >/dev/null || abort backup "knowledge copy differs"
echo "backup: $OUT ($(du -sh $OUT | cut -f1))"

# ---- code
git -C $R merge --ff-only "$TFULL" >/dev/null || abort merge "fast-forward failed"
# Rollback puts the master branch itself back on the base commit (not a detached HEAD: the next release's "on master" guard must still pass) and
# restores the dependency tree of that commit before rebuilding, so a dependency change in the failed target can never leave the base unbuildable.
rollback() {
  echo "ROLLING BACK to ${HEAD:0:7}"
  git -C $R checkout -q -B master "$HEAD"
  if [ "$PKG" -gt 0 ]; then (cd $R && npm ci --silent </dev/null) || echo "warning: npm ci for the base commit failed; the previous node_modules may be incomplete"; fi
  (cd $R && npm run build --silent </dev/null) || echo "warning: rebuild of the base commit failed; dist/ left as it was"
  sudo systemctl restart $SVC </dev/null || true
  echo "rolled back (database migration, if any, is additive and kept; backup at $OUT)"
}
# A full install: `npm run build` needs the dev dependencies (typescript); production code only loads the runtime ones, as before.
if [ "$PKG" -gt 0 ]; then (cd $R && npm ci --silent </dev/null) || { rollback; abort deps "npm ci failed"; }; fi
(cd $R && npm run build --silent </dev/null) || { rollback; abort build "build failed"; }
# the build stamp the dashboard footer shows (ignored by Git; same shape the static launcher writes)
printf '{"commit":"%s","fullCommit":"%s","branch":"master","environment":"production","releasedAt":"%s","writtenBy":"scripts/release-full.sh"}\n' "$(git -C $R rev-parse --short HEAD)" "$(git -C $R rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > $R/dashboard/build-info.json
sudo systemctl restart $SVC </dev/null
for i in $(seq 1 30); do sleep 1; [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health)" = 200 ] && break; done

# ---- proof (every probe is tolerant: a failed curl yields "000" and is judged below; under `set -e` an unguarded failure here would
# end the script silently AFTER the restart, leaving the release in place but unproven — which is what happened on 2026-10-13)
H=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health || echo 000); RD=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/readiness || echo 000)
PUB=$(curl -s -o /dev/null -w '%{http_code}' https://whatsapp.alfarooque.com/health || echo 000)
# `grep -c` exits 1 when it counts ZERO lines: with nothing listening on 3005 (the other project stopped) the 4d5c9ce release of
# 2026-10-13 ended silently right here, after the restart and before the proof. `|| true` keeps the count and ignores the status.
L3000=$(ss -ltn | grep -c ":$PORT " || true); L3005=$(ss -ltn | grep -c ':3005 ' || true)
AFTER=$(fp)
echo "after: health=$H readiness=$RD public=$PUB listen3000=$L3000 listen3005=$L3005 service=$(systemctl is-active $SVC) head=$(git -C $R rev-parse --short HEAD) migrations=$(sqlite3 "file:$DB?mode=ro" 'SELECT count(*) FROM schema_migrations;') last=$(sqlite3 "file:$DB?mode=ro" 'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1;')"
echo "fingerprints after:  $AFTER"
[ "$H" = 200 ] && [ "$RD" = 200 ] && [ "$L3000" = 1 ] && [ "$(systemctl is-active $SVC)" = active ] || { rollback; abort proof "post-release check failed"; }
# the baileys identity fingerprint must be unchanged (a restart rotates pre-keys, never the identity); everything else must be identical
for k in admins creds accounts customers messages baileys_identity uploads knowledge; do
  [ "$(echo "$BEFORE" | tr ' ' '\n' | grep "^$k=")" = "$(echo "$AFTER" | tr ' ' '\n' | grep "^$k=")" ] || { rollback; abort proof "fingerprint $k changed"; }
done
echo "RELEASED: $(git -C $R rev-parse --short HEAD) is live on port $PORT; backup $OUT"
