#!/bin/bash
# Adds ONE upstream provider account to the OmniRoute gateway ON THIS SERVER through the gateway's own loopback API, and proves it was saved.
#
#   scp -i "$HOME/.ssh/oracle-whatsapp-ai.key" scripts/omniroute-add-provider.sh ubuntu@130.110.112.192:/tmp/
#   ssh -t -i "$HOME/.ssh/oracle-whatsapp-ai.key" ubuntu@130.110.112.192 'tr -d "\r" < /tmp/omniroute-add-provider.sh > /tmp/add-provider.sh && bash /tmp/add-provider.sh'
#
# Why it exists: the gateway dashboard's "Test" (validate) and "Save" are two separate actions; a passing test persists nothing, and an add that never
# reaches POST /api/providers leaves the gateway with zero connections. This script does both steps and then reads the connection back.
#
# Security: the key is read with a hidden prompt (never an argument, never echoed, never written to disk or shell history), is passed to the request
# through the environment of one short-lived process, and is not printed. The dashboard password is read from the 600 file that the setup created.
# It uses only the loopback address 127.0.0.1:20128. It never touches the WhatsApp application. Free tier only: use a provider account whose
# plan you have verified is free; nothing here enables billing.
set -u
umask 077
BASE=http://127.0.0.1:20128
PWFILE=/home/ubuntu/.omniroute-dashboard-password
[ -r "$PWFILE" ] || { echo "Dashboard password file not found ($PWFILE). Sign in to the dashboard once and use its Providers page instead."; exit 1; }

read -r -p "Provider id (the gateway's id, e.g. groq, gemini, openrouter, cerebras, mistral): " PROVIDER
case "$PROVIDER" in *[!a-z0-9._-]*|"") echo "Provider id must be lower-case letters, digits, . _ -"; exit 1;; esac
read -r -p "Connection name [${PROVIDER} (free tier)]: " NAME; NAME=${NAME:-"${PROVIDER} (free tier)"}
read -r -s -p "API key for ${PROVIDER} (input hidden): " KEYVAL; echo
[ -n "$KEYVAL" ] || { echo "No key entered."; exit 1; }

JAR=$(mktemp); TMP=$(mktemp)
cleanup() { unset KEYVAL; shred -u "$JAR" "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

PW=$(cat "$PWFILE")
code=$(PW="$PW" node -e 'process.stdout.write(JSON.stringify({password:process.env.PW}))' | curl -s -m 20 -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' --data-binary @- $BASE/api/auth/login)
unset PW
[ "$code" = 200 ] || { echo "Gateway sign-in failed (HTTP $code). If the password was changed, sign in to the dashboard and use its Providers page."; exit 1; }

safe() { node -e '
const BAD=/key|secret|token|password|cookie|credential/i;
try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
 const s=(v,d=0)=>Array.isArray(v)?v.slice(0,5).map(x=>s(x,d+1)):(v&&typeof v==="object")?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,BAD.test(k)?"[hidden]":(d>3?"…":s(x,d+1))])):(typeof v==="string"&&v.length>160?v.slice(0,160)+"…":v);
 console.log(JSON.stringify(s(j)).slice(0,700))}catch(e){console.log("(non-JSON answer)")}' "$1"; }

echo "1/4 Checking the key with the provider (nothing is saved yet)..."
code=$(K="$KEYVAL" P="$PROVIDER" node -e 'process.stdout.write(JSON.stringify({provider:process.env.P,apiKey:process.env.K}))' | curl -s -m 60 -o "$TMP" -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' --data-binary @- $BASE/api/providers/validate)
echo "    validate: HTTP $code  $(safe "$TMP")"
VALID=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).valid===true?"yes":"no")}catch(e){console.log("no")}' "$TMP")
[ "$VALID" = yes ] || { echo "The provider did not accept this key (see the message above). Nothing was saved."; exit 2; }

echo "2/4 Saving the connection..."
code=$(K="$KEYVAL" P="$PROVIDER" N="$NAME" node -e 'process.stdout.write(JSON.stringify({provider:process.env.P,name:process.env.N,apiKey:process.env.K}))' | curl -s -m 60 -o "$TMP" -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' --data-binary @- $BASE/api/providers)
echo "    create: HTTP $code  $(safe "$TMP")"
[ "$code" = 201 ] || { echo "The gateway did not save it. Nothing was persisted."; exit 3; }
ID=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).connection.id||"")}catch(e){console.log("")}' "$TMP")
unset KEYVAL

echo "3/4 Reading it back from the gateway (persistence check)..."
curl -s -m 20 -b "$JAR" $BASE/api/providers -o "$TMP"
node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const id=process.argv[2];
const c=(j.connections||[]).find(x=>x.id===id);
console.log(c?`    PERSISTED: ${c.provider} / ${c.name} / active=${c.isActive} / testStatus=${c.testStatus} (total connections: ${j.total})`:"    NOT FOUND after save - do not rely on it");
process.exit(c?0:4)' "$TMP" "$ID" || exit 4

echo "4/4 Importing the provider's model list (read-only on the provider side)..."
code=$(curl -s -m 60 -o "$TMP" -w '%{http_code}' -X POST -b "$JAR" $BASE/api/providers/$ID/sync-models)
echo "    sync-models: HTTP $code  $(safe "$TMP")"
echo
echo "Done. Tell the assistant: 'provider connected'. It will re-check the gateway database and run the real inference test."
