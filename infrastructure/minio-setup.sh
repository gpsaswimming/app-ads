#!/usr/bin/env bash
# MinIO provisioning for the Scoreboard Ads platform (DESIGN.md §4). Idempotent.
# Creates the private gpsa-ads bucket, subscribes it to the ObjectCreated webhook that
# points at the Ads API, adds a pending-cleanup lifecycle rule, and mints a scoped
# service account for the Ads API (root credentials are never used by the app).
#
# Run on the DMZ VM (or anywhere with LAN access to MinIO :9000) after `docker compose
# -f docker-compose.dmz.yml up -d`. Requires the MinIO client `mc` on PATH.
#
#   MINIO_URL=http://localhost:9000 \
#   MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... \
#   ./minio-setup.sh
#
# Prints MINIO_ACCESS_KEY / MINIO_SECRET_KEY to paste into ads-api.env.
set -euo pipefail

MINIO_URL="${MINIO_URL:-http://localhost:9000}"
: "${MINIO_ROOT_USER:?set MINIO_ROOT_USER (from minio.env)}"
: "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD (from minio.env)}"
BUCKET="${MINIO_BUCKET:-gpsa-ads}"
ALIAS="gpsaads-setup"

command -v mc >/dev/null || { echo "error: the MinIO client 'mc' is required on PATH" >&2; exit 1; }

echo ">> pointing mc at ${MINIO_URL}"
mc alias set "$ALIAS" "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

echo ">> creating private bucket ${BUCKET} (no public ACL)"
mc mb --ignore-existing "$ALIAS/$BUCKET" >/dev/null
mc anonymous set none "$ALIAS/$BUCKET" >/dev/null 2>&1 || true

echo ">> subscribing ${BUCKET} to the ObjectCreated webhook (arn:minio:sqs::ADS:webhook)"
# The webhook TARGET is configured on the server via MINIO_NOTIFY_WEBHOOK_*_ADS (minio.env);
# here we subscribe the bucket's s3:ObjectCreated events to it. --ignore-existing keeps it idempotent.
mc event add "$ALIAS/$BUCKET" arn:minio:sqs::ADS:webhook --event put --ignore-existing >/dev/null 2>&1 \
  || mc event add "$ALIAS/$BUCKET" arn:minio:sqs::ADS:webhook --event put >/dev/null

echo ">> adding lifecycle rule: expire pending uploads after 30 days"
# NOTE: object keys are {ad_uuid}/pending_{file} and become {ad_uuid}/approved_{file} on
# approval, so a plain path-prefix rule can't isolate the pending ones. We target them by a
# `state=pending` object tag instead. This rule is inert until pending objects carry that tag
# (a one-line addition to the presign policy / rename step — see infrastructure/README.md),
# so it is safe to create now and never touches approved artwork.
mc ilm rule add "$ALIAS/$BUCKET" --expire-days 30 --tags "state=pending" >/dev/null 2>&1 \
  || echo "   (lifecycle rule already present or unsupported on this MinIO — skipping)"

echo ">> creating a scoped service account for the Ads API (limited to ${BUCKET})"
POLICY="$(mktemp)"
trap 'rm -f "$POLICY"' EXIT
cat > "$POLICY" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/*"] },
    { "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}"] }
  ]
}
JSON

SVC_JSON="$(mc admin user svcacct add "$ALIAS" "$MINIO_ROOT_USER" --policy "$POLICY" --json)"
# mc --json prints one JSON object; pull the two keys without a JSON dependency (mc-only).
ACCESS_KEY="$(printf '%s' "$SVC_JSON" | grep -o '"accessKey"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
SECRET_KEY="$(printf '%s' "$SVC_JSON" | grep -o '"secretKey"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$ACCESS_KEY" ] && [ -n "$SECRET_KEY" ] || { echo "error: could not parse service account from: $SVC_JSON" >&2; exit 1; }

cat <<OUT

============================================================
 MinIO provisioning complete. Paste into ads-api.env:
------------------------------------------------------------
MINIO_ACCESS_KEY=${ACCESS_KEY}
MINIO_SECRET_KEY=${SECRET_KEY}
============================================================
OUT
