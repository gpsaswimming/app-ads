#!/usr/bin/env bash
# Generate the per-tier .env files from the committed *.env.example templates, filling
# the randomly-generatable secrets and keeping the shared webhook secret identical across
# minio.env and ads-api.env (DESIGN.md §7). Values that come from elsewhere are left as
# `changeme-*` placeholders for you to fill:
#   - MINIO_ACCESS_KEY / MINIO_SECRET_KEY          → from ./minio-setup.sh
#   - NOCODB_URL / _BASE_ID / _ADS_TABLE_ID / _TOKEN → from ./nocodb-setup.sh
#   - TURNSTILE_SECRET / TURNSTILE_SITE_KEY / GEMINI_API_KEY / SMTP_URL → your accounts
#   - UPLOAD_URL / API_UPSTREAM / ALLOW_ORIGIN / SUBMISSION_DEADLINE / GPSA_CHECK_ADDRESS → deploy values
#
# Writes into this directory. Refuses to clobber an existing .env unless FORCE=1.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

rand() { openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

SHARED_WEBHOOK_SECRET="$(rand)"
MINIO_ROOT_PW="$(rand)"
NC_JWT="$(rand)"

emit() { # $1=example path  $2=output name  then sed find/replace pairs...
  local src="$1" name="$2" out="$HERE/$2"; shift 2
  if [ -e "$out" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "   skip $name (exists; set FORCE=1 to overwrite)"; return
  fi
  cp "$src" "$out"
  while [ "$#" -ge 2 ]; do
    # replace `KEY=<old>` line's value, matching the committed placeholder exactly
    python3 - "$out" "$1" "$2" <<'PY'
import sys
path, find, repl = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read().replace(find, repl)
open(path, 'w').write(s)
PY
    shift 2
  done
  chmod 600 "$out"
  echo "   wrote $name (chmod 600)"
}

echo ">> generating per-tier .env files in $HERE"

emit "$HERE/minio.env.example" "minio.env" \
  "changeme-root-user" "gpsa-ads-admin" \
  "changeme-root-password" "$MINIO_ROOT_PW" \
  "changeme-shared-webhook-secret" "$SHARED_WEBHOOK_SECRET"

emit "$ROOT/services/ads-api/ads-api.env.example" "ads-api.env" \
  "changeme-shared-webhook-secret" "$SHARED_WEBHOOK_SECRET"

emit "$HERE/nocodb.env.example" "nocodb.env" \
  "changeme-jwt-secret" "$NC_JWT"

emit "$ROOT/web/web.env.example" "web.env"
emit "$ROOT/proxy/proxy.env.example" "proxy.env"

cat <<OUT

>> done. Next:
   1. Fill the remaining changeme-* / deploy values in ads-api.env, web.env, proxy.env.
   2. Bring up the data tier, run ./nocodb-setup.sh, paste its NOCODB_* into ads-api.env.
   3. Bring up MinIO, run ./minio-setup.sh, paste its MINIO_ACCESS/SECRET_KEY into ads-api.env.
   4. Bring up the app + dmz tiers.
   The shared webhook secret is already identical in minio.env and ads-api.env.
OUT
