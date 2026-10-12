#!/usr/bin/env bash
# Guarded STATIC dashboard release for the WhatsApp AI Agent (files under dashboard/, docs/, tests/ only).
# No restart, no build, no migration, no database/auth/session/customer-data write. Only ever touches app port 3000, never 3005.
#
#   deploy-static-ui.sh --base <sha> --target <sha> [--check-only]
#
# Runs ON THE SERVER (streamed over ssh by scripts/deploy-static-ui.ps1). --check-only runs every precondition and writes nothing.
# Every precondition is checked before the first write; any failure prints "ABORT[<step>]: <reason>" and exits non-zero.
set -Eeuo pipefail

: "${DEPLOY_REPO:=/home/ubuntu/whatsapp-ai-agent}"
: "${DEPLOY_DATA:=/home/ubuntu/whatsapp-data}"
: "${DEPLOY_BACKUP_ROOT:=/home/ubuntu/whatsapp-backups}"
: "${DEPLOY_APP_PORT:=3000}"
: "${DEPLOY_PUBLIC_URL:=https://whatsapp.alfarooque.com}"
: "${DEPLOY_SERVICE:=whatsapp-ai-agent}"
: "${DEPLOY_SPACE_FACTOR:=3}"
: "${DEPLOY_ORIGIN_RE:=github\.com[:/]ahmedalfarooque/whatsapp-ai-agent(\.git)?$}"
SCOPE_RE='^(dashboard/|docs/|tests/|(AGENTS\.md|\.gitignore|\.project-sync/(PROJECT|COWORK)\.md|scripts/(deploy-static-ui\.(sh|ps1)|env-report\.cjs))$)'

BASE=""; TARGET=""; CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) echo "ABORT[args]: unknown argument '$1'"; exit 2 ;;
  esac
done

STEP="start"
abort() { echo "ABORT[$STEP]: $1"; exit 1; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
trap 'echo "ABORT[$STEP]: unexpected error on line $LINENO"' ERR

# ---------------------------------------------------------------- 1. identity: right repo, right place, right port
STEP="arguments"
[[ "$BASE" =~ ^[0-9a-f]{7,40}$ ]] || abort "--base must be a commit hash"
[[ "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || abort "--target must be a commit hash"

STEP="port-guard"
[ "$DEPLOY_APP_PORT" != "3005" ] || abort "port 3005 belongs to an unrelated project and must never be targeted"
[ "$DEPLOY_APP_PORT" = "3000" ] || [ -n "${DEPLOY_ALLOW_OTHER_PORT:-}" ] || abort "application port must be 3000 (got $DEPLOY_APP_PORT)"
[ "$DEPLOY_SERVICE" = "whatsapp-ai-agent" ] || [ -n "${DEPLOY_ALLOW_OTHER_SERVICE:-}" ] || abort "service must be whatsapp-ai-agent (got $DEPLOY_SERVICE)"

STEP="repo-identity"
[[ "$DEPLOY_REPO" = /* ]] || abort "repository path must be absolute"
[ -d "$DEPLOY_REPO" ] || abort "repository path does not exist: $DEPLOY_REPO"
[ ! -L "$DEPLOY_REPO" ] || abort "repository path is a symlink: $DEPLOY_REPO"
cd "$DEPLOY_REPO"
TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || abort "not a git repository: $DEPLOY_REPO"
[ -z "$(git rev-parse --show-prefix)" ] || abort "path is inside a different repository (toplevel $TOP)"
ORIGIN="$(git remote get-url origin 2>/dev/null)" || abort "repository has no origin remote"
[[ "$ORIGIN" =~ $DEPLOY_ORIGIN_RE ]] || abort "origin is not the WhatsApp AI Agent repository"
[ "$(git branch --show-current)" = "master" ] || abort "checkout is not on branch master"
[ ! -L "$DEPLOY_REPO/dashboard" ] || abort "dashboard directory is a symlink; served files would not be the checkout"
[ -d "$DEPLOY_REPO/dashboard" ] || abort "dashboard directory missing"
log "repo=$DEPLOY_REPO origin=ok branch=master port=$DEPLOY_APP_PORT service=$DEPLOY_SERVICE"

# ---------------------------------------------------------------- 2. commits and scope
STEP="live-commit"
HEAD_NOW="$(git rev-parse HEAD)"
BASE_FULL="$(git rev-parse --verify "$BASE^{commit}" 2>/dev/null)" || abort "base commit $BASE is unknown to this repository"
[ "$HEAD_NOW" = "$BASE_FULL" ] || abort "live HEAD is $(git rev-parse --short HEAD), expected base $BASE"
[ "$(git status --porcelain --untracked-files=no | wc -l)" = "0" ] || abort "live checkout has uncommitted tracked changes"

STEP="target-commit"
git fetch --quiet origin || abort "git fetch origin failed"
TARGET_FULL="$(git rev-parse --verify "$TARGET^{commit}" 2>/dev/null)" || abort "target commit $TARGET is not available after fetch"
[ "$(git rev-parse origin/master)" = "$TARGET_FULL" ] || abort "origin/master is $(git rev-parse --short origin/master), not the intended target $TARGET"
git merge-base --is-ancestor "$BASE_FULL" "$TARGET_FULL" || abort "target is not a fast-forward of the live commit"

STEP="release-scope"
CHANGED="$(git diff --name-only "$BASE_FULL" "$TARGET_FULL")"
[ -n "$CHANGED" ] || abort "release contains no changes"
OUT_OF_SCOPE="$(printf '%s\n' "$CHANGED" | grep -Ev "$SCOPE_RE" || true)"
[ -z "$OUT_OF_SCOPE" ] || abort "release touches files outside dashboard/, docs/, tests/: $(printf '%s' "$OUT_OF_SCOPE" | tr '\n' ' ')"
log "release scope ok: $(printf '%s\n' "$CHANGED" | wc -l) files, all inside the static allow-list"

STEP="release-assets"
git cat-file -e "$TARGET_FULL:dashboard/index.html" 2>/dev/null || abort "target has no dashboard/index.html"
git cat-file -e "$TARGET_FULL:dashboard/tokens.css" 2>/dev/null || abort "target has no dashboard/tokens.css"
ASSETS="$(git show "$TARGET_FULL:dashboard/index.html" | grep -oE '(href|src)="/dashboard/[^"?#]+\.(css|js)' | sed -E 's/^(href|src)="\/dashboard\///' | sort -u)"
[ -n "$ASSETS" ] || abort "index.html references no stylesheets or scripts"
while IFS= read -r a; do
  git cat-file -e "$TARGET_FULL:dashboard/$a" 2>/dev/null || abort "index.html references /dashboard/$a but the target does not contain it"
done <<< "$ASSETS"
printf '%s\n' "$ASSETS" | grep -qx 'tokens.css' || abort "index.html does not reference tokens.css"
REMOVED="$(git diff --name-only --diff-filter=D "$BASE_FULL" "$TARGET_FULL" -- dashboard | sed 's#^dashboard/##' | grep -E '\.(css|js)$' || true)"
if [ -n "$REMOVED" ]; then
  while IFS= read -r r; do
    ! printf '%s\n' "$ASSETS" | grep -qx "$r" || abort "index.html still references removed file $r"
  done <<< "$REMOVED"
fi
log "assets ok: $(printf '%s\n' "$ASSETS" | wc -l) referenced, all present in the target; removed: ${REMOVED:-none}"

# ---------------------------------------------------------------- 3. backup destination (checked before any write)
STEP="backup-destination"
[ -d "$DEPLOY_BACKUP_ROOT" ] || abort "backup root does not exist: $DEPLOY_BACKUP_ROOT"
NEED_KB=0
for p in "$DEPLOY_DATA/app.db" "$DEPLOY_REPO/dashboard" "$DEPLOY_REPO/knowledge"; do
  [ -e "$p" ] || abort "cannot back up missing path: $p"
  NEED_KB=$(( NEED_KB + $(du -sk "$p" | cut -f1) ))
done
NEED_KB=$(( NEED_KB * DEPLOY_SPACE_FACTOR + 1024 ))
FREE_KB="$(df -Pk "$DEPLOY_BACKUP_ROOT" | awk 'NR==2{print $4}')"
[ "$FREE_KB" -ge "$NEED_KB" ] || abort "not enough free space for the backup (need ~${NEED_KB}KB, have ${FREE_KB}KB)"
if [ -w "$DEPLOY_BACKUP_ROOT" ]; then
  BACKUP_MODE="direct"
elif sudo -n true 2>/dev/null; then
  BACKUP_MODE="sudo-install-single-directory"
else
  abort "backup root is not writable and non-interactive sudo is not available"
fi
log "backup destination ok: root=$DEPLOY_BACKUP_ROOT mode=$BACKUP_MODE free=${FREE_KB}KB need~${NEED_KB}KB"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "CHECK-ONLY OK: every precondition passed; nothing was written"
  exit 0
fi

# ---------------------------------------------------------------- 4. runtime preconditions
STEP="runtime"
[ "$(systemctl is-active "$DEPLOY_SERVICE")" = "active" ] || abort "service $DEPLOY_SERVICE is not active"
local_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$DEPLOY_APP_PORT$1" || true; }
public_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$DEPLOY_PUBLIC_URL$1" || true; }
[ "$(local_code /health)" = "200" ] || abort "application health is not 200 before the release"
LISTEN_BEFORE="$(ss -ltn | grep -c ":$DEPLOY_APP_PORT " || true)"
L3005_BEFORE="$(ss -ltn | grep -c ':3005 ' || true)"
[ "$LISTEN_BEFORE" = "1" ] || abort "expected exactly one listener on $DEPLOY_APP_PORT before the release (found $LISTEN_BEFORE)"

fp() {
  echo "superadmin=$(sqlite3 -readonly "$DEPLOY_DATA/app.db" "SELECT * FROM admin_users WHERE is_protected=1" | sha256sum | cut -c1-12) credentials=$(sqlite3 -readonly "$DEPLOY_DATA/app.db" "SELECT * FROM credential_overrides ORDER BY 1" | sha256sum | cut -c1-12) knowledge=$(cd "$DEPLOY_REPO/knowledge" && find . -path ./.backups -prune -o -type f -print | sort | xargs sha256sum | sha256sum | cut -c1-12)"
  echo "baileys=$(find "$DEPLOY_DATA/baileys-auth" -type f -printf '%P %s\n' | sort | sha256sum | cut -c1-12) uploads=$(find "$DEPLOY_DATA/uploads" -type f -printf '%P %s\n' | sort | sha256sum | cut -c1-12) code=$(cd "$DEPLOY_REPO" && find src dist -type f | sort | xargs sha256sum | sha256sum | cut -c1-12)"
  echo "accounts=$(sqlite3 -readonly "$DEPLOY_DATA/app.db" "SELECT id||':'||status FROM whatsapp_accounts ORDER BY id" | tr '\n' ' ') pid=$(systemctl show "$DEPLOY_SERVICE" -p MainPID --value)"
}
FP_BEFORE="$(fp)"

# ---------------------------------------------------------------- 5. backup (verified before the live checkout changes)
STEP="backup"
B="$DEPLOY_BACKUP_ROOT/pre-ui-redesign-$(date +%Y%m%d-%H%M%S)"
[ ! -e "$B" ] || abort "backup path already exists: $B"
if [ "$BACKUP_MODE" = "direct" ]; then
  mkdir "$B" && chmod 700 "$B"
else
  # exactly one new directory, owned by the deploy user; the existing backup tree is never re-owned
  sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 700 "$B"
fi
[ -d "$B" ] && [ -w "$B" ] && [ "$(stat -c %U "$B")" = "$(id -un)" ] || abort "backup directory $B is not owned and writable by $(id -un)"
sqlite3 "$DEPLOY_DATA/app.db" ".backup '$B/app.db'"
cp -a "$DEPLOY_REPO/dashboard" "$B/dashboard"
cp -a "$DEPLOY_REPO/knowledge" "$B/knowledge"
[ "$(sqlite3 -readonly "$B/app.db" 'PRAGMA integrity_check')" = "ok" ] || abort "backup database failed its integrity check"
[ -s "$B/app.db" ] || abort "backup database is empty"
diff -r "$DEPLOY_REPO/dashboard" "$B/dashboard" >/dev/null || abort "backup copy of dashboard differs from the live directory"
log "BACKUP=$B integrity=ok dashboard-copy=identical db=$(du -k "$B/app.db" | cut -f1)KB"

# ---------------------------------------------------------------- 6. release (fast-forward only)
STEP="release"
git merge --ff-only "$TARGET_FULL" >/dev/null || abort "fast-forward failed"
[ "$(git rev-parse HEAD)" = "$TARGET_FULL" ] || abort "live HEAD is not the target after the fast-forward"
[ "$(git status --porcelain --untracked-files=no | wc -l)" = "0" ] || abort "live checkout is dirty after the fast-forward"
log "live commit now $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------- 7. post-release proof (served assets, health, ports, untouched state)
FAILS=()
check() { if ! "$@"; then FAILS+=("$*"); fi; }
code_is() { [ "$($1 "$2")" = "$3" ]; }
STEP="verify"
check code_is local_code /health 200
check code_is local_code /readiness 200
check code_is public_code /health 200
while IFS= read -r a; do
  check code_is local_code "/dashboard/$a" 200
  check code_is public_code "/dashboard/$a" 200
done <<< "$ASSETS"
if [ -n "$REMOVED" ]; then
  while IFS= read -r r; do check code_is local_code "/dashboard/$r" 404; done <<< "$REMOVED"
fi
LIVE_INDEX="$(curl -s --max-time 15 "$DEPLOY_PUBLIC_URL/dashboard/" || true)"
while IFS= read -r a; do
  printf '%s' "$LIVE_INDEX" | grep -q "/dashboard/$a" || FAILS+=("public index does not reference $a")
done <<< "$ASSETS"
check [ "$(ss -ltn | grep -c ":$DEPLOY_APP_PORT " || true)" = "$LISTEN_BEFORE" ]
check [ "$(ss -ltn | grep -c ':3005 ' || true)" = "$L3005_BEFORE" ]
check [ "$(systemctl is-active "$DEPLOY_SERVICE")" = "active" ]
FP_AFTER="$(fp)"
[ "$FP_BEFORE" = "$FP_AFTER" ] || FAILS+=("production state fingerprints changed")

if [ "${#FAILS[@]}" -gt 0 ]; then
  echo "VERIFY FAILED:"; printf '  - %s\n' "${FAILS[@]}"
  echo "Applying the documented rollback (non-destructive, static files only): git checkout --detach $BASE_FULL"
  git checkout --quiet --detach "$BASE_FULL"
  log "rolled back to $(git rev-parse --short HEAD); health=$(local_code /health) old stylesheet=$(local_code /dashboard/ui.css). Backup kept at $B"
  STEP="verify"; abort "post-release checks failed; rolled back to $BASE"
fi

echo "== AFTER: commit=$(git rev-parse --short HEAD) health=$(local_code /health) readiness=$(local_code /readiness) public=$(public_code /health)"
echo "== ports: $DEPLOY_APP_PORT listeners=$(ss -ltn | grep -c ":$DEPLOY_APP_PORT " || true) 3005 listeners=$(ss -ltn | grep -c ':3005 ' || true)"
while IFS= read -r a; do echo "   /dashboard/$a local=$(local_code "/dashboard/$a") public=$(public_code "/dashboard/$a")"; done <<< "$ASSETS"
[ -n "$REMOVED" ] && while IFS= read -r r; do echo "   removed /dashboard/$r -> $(local_code "/dashboard/$r")"; done <<< "$REMOVED"
echo "== state fingerprints unchanged (accounts, sessions, uploads, credentials, knowledge, code, pid)"
echo "$FP_AFTER" | sed 's/^/   /'
echo "ROLLBACK (if ever needed): cd $DEPLOY_REPO && git checkout --detach $BASE_FULL   # static files only, no restart; 'git checkout master' returns to the release"
echo "DEPLOY OK: $(git rev-parse --short HEAD)  backup=$B"
