#!/usr/bin/env bash
# NocoDB provisioning for the Scoreboard Ads platform (DESIGN.md §4). Idempotent-ish:
# reuses an existing base/table by title if present, otherwise creates them. Creates the
# `Ads` table with the exact fields/enums the Ads API reads and writes, then mints an API
# token. Requires curl + python3 (stdlib only) on PATH.
#
# Run after `docker compose -f docker-compose.data.yml up -d`:
#
#   NC_URL=http://localhost:8080 \
#   NC_ADMIN_EMAIL=admin@gpsa.local NC_ADMIN_PASSWORD='choose-a-strong-one' \
#   ./nocodb-setup.sh
#
# The first run also creates the NocoDB super-admin (first signup wins). Prints the
# NOCODB_* values to paste into ads-api.env.
set -euo pipefail

NC_URL="${NC_URL:-http://localhost:8080}"
NC_ADMIN_EMAIL="${NC_ADMIN_EMAIL:-admin@gpsa.local}"
: "${NC_ADMIN_PASSWORD:?set NC_ADMIN_PASSWORD (chosen super-admin password; created on first run)}"
BASE_TITLE="${NC_BASE_TITLE:-GPSA Ads}"
TABLE_TITLE="Ads"

command -v curl >/dev/null    || { echo "error: curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 is required" >&2; exit 1; }

# Both read JSON from stdin (piped) and take an argument; the program lives in -c so the
# pipe owns stdin. Parse errors (non-JSON error bodies) yield empty output.
pyget()  { python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d.get(sys.argv[1],"") if isinstance(d,dict) else "")' "$1" 2>/dev/null; }
pyfind() { python3 -c 'import sys,json
d=json.load(sys.stdin)
items=d.get("list",[]) if isinstance(d,dict) else (d if isinstance(d,list) else [])
for it in items:
    if isinstance(it,dict) and it.get("title")==sys.argv[1]:
        print(it.get("id",""));break' "$1" 2>/dev/null; }

echo ">> authenticating to NocoDB at ${NC_URL}"
RESP="$(curl -s -X POST "$NC_URL/api/v1/auth/user/signin" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NC_ADMIN_EMAIL\",\"password\":\"$NC_ADMIN_PASSWORD\"}")"
JWT="$(printf '%s' "$RESP" | pyget token)"
if [ -z "$JWT" ]; then
  echo "   no existing admin — signing up ${NC_ADMIN_EMAIL} as super-admin"
  RESP="$(curl -s -X POST "$NC_URL/api/v1/auth/user/signup" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$NC_ADMIN_EMAIL\",\"password\":\"$NC_ADMIN_PASSWORD\"}")"
  JWT="$(printf '%s' "$RESP" | pyget token)"
fi
[ -n "$JWT" ] || { echo "error: authentication failed: $RESP" >&2; exit 1; }

echo ">> finding or creating base \"${BASE_TITLE}\""
BASE_ID="$(curl -s "$NC_URL/api/v2/meta/bases" -H "xc-auth: $JWT" | pyfind "$BASE_TITLE")"
if [ -z "$BASE_ID" ]; then
  BASE_ID="$(curl -s -X POST "$NC_URL/api/v2/meta/bases" -H "xc-auth: $JWT" \
    -H 'Content-Type: application/json' -d "{\"title\":\"$BASE_TITLE\"}" | pyget id)"
fi
[ -n "$BASE_ID" ] || { echo "error: could not create/find base" >&2; exit 1; }
echo "   base id: ${BASE_ID}"

echo ">> finding or creating the ${TABLE_TITLE} table"
TABLE_ID="$(curl -s "$NC_URL/api/v2/meta/bases/$BASE_ID/tables" -H "xc-auth: $JWT" | pyfind "$TABLE_TITLE")"
if [ -z "$TABLE_ID" ]; then
  TABLE_ID="$(curl -s -X POST "$NC_URL/api/v2/meta/bases/$BASE_ID/tables" -H "xc-auth: $JWT" \
    -H 'Content-Type: application/json' --data-binary @- <<'JSON' | pyget id
{
  "title": "Ads",
  "columns": [
    { "title": "Ad_ID", "uidt": "SingleLineText" },
    { "title": "Meet", "uidt": "SingleLineText" },
    { "title": "Submitter_Name", "uidt": "SingleLineText" },
    { "title": "Submitter_Email", "uidt": "Email" },
    { "title": "Submitter_Phone", "uidt": "SingleLineText" },
    { "title": "Submitter_Is_Advertiser", "uidt": "Checkbox" },
    { "title": "Company_Name", "uidt": "SingleLineText" },
    { "title": "Advertiser_Name", "uidt": "SingleLineText" },
    { "title": "Advertiser_Email", "uidt": "Email" },
    { "title": "Advertiser_Phone", "uidt": "SingleLineText" },
    { "title": "Team", "uidt": "SingleSelect", "colOptions": { "options": [
      {"title":"Beaconsdale"},{"title":"Colony"},{"title":"Coventry"},{"title":"Elizabeth Lake"},
      {"title":"Glendale"},{"title":"Hidenwood"},{"title":"James River"},{"title":"Kiln Creek"},
      {"title":"Marlbank"},{"title":"Poquoson"},{"title":"Riverdale"},{"title":"Running Man"},
      {"title":"Village Green"},{"title":"Warwick Yacht"},{"title":"Wendwood"},{"title":"Willow Oaks"},
      {"title":"Windy Point"},{"title":"Wythe"},{"title":"GPSA"} ] } },
    { "title": "Ad_Title", "uidt": "SingleLineText" },
    { "title": "Placement", "uidt": "SingleSelect", "colOptions": { "options": [
      {"title":"FULL_SCREEN"},{"title":"HALF_SCREEN"} ] } },
    { "title": "Status", "uidt": "SingleSelect", "colOptions": { "options": [
      {"title":"AWAITING_UPLOAD"},{"title":"UPLOADED"},{"title":"VALIDATING"},
      {"title":"APPROVED"},{"title":"REJECTED"},{"title":"NEEDS_REVIEW"} ] } },
    { "title": "Artwork_URI", "uidt": "SingleLineText" },
    { "title": "Artwork_Filename", "uidt": "SingleLineText" },
    { "title": "Content_Type", "uidt": "SingleLineText" },
    { "title": "Artwork_Bytes", "uidt": "Number" },
    { "title": "Artwork_Width", "uidt": "Number" },
    { "title": "Artwork_Height", "uidt": "Number" },
    { "title": "Validation_Notes", "uidt": "LongText" },
    { "title": "Rights_Confirmed", "uidt": "Checkbox" },
    { "title": "Rights_Confirmed_At", "uidt": "DateTime" },
    { "title": "Payment_Method", "uidt": "SingleSelect", "colOptions": { "options": [
      {"title":"PAY_TEAM"},{"title":"CHECK"},{"title":"SQUARE_INVOICE"} ] } },
    { "title": "Payment_Amount", "uidt": "Number" },
    { "title": "Payment_Status", "uidt": "SingleSelect", "colOptions": { "options": [
      {"title":"PENDING"},{"title":"PAID"},{"title":"WAIVED"} ] } }
  ]
}
JSON
)"
fi
[ -n "$TABLE_ID" ] || { echo "error: could not create/find the Ads table" >&2; exit 1; }
echo "   table id: ${TABLE_ID}"

echo ">> minting an API token for the Ads API"
API_TOKEN="$(curl -s -X POST "$NC_URL/api/v1/tokens" -H "xc-auth: $JWT" \
  -H 'Content-Type: application/json' -d '{"description":"ads-api"}' | pyget token)"
[ -n "$API_TOKEN" ] || { echo "error: could not create API token" >&2; exit 1; }

cat <<OUT

============================================================
 NocoDB provisioning complete. Paste into ads-api.env:
------------------------------------------------------------
NOCODB_URL=${NC_URL}
NOCODB_BASE_ID=${BASE_ID}
NOCODB_ADS_TABLE_ID=${TABLE_ID}
NOCODB_TOKEN=${API_TOKEN}
============================================================
 (Re-running mints an additional token; revoke unused ones in the NocoDB UI.)
OUT
