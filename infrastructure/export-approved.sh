#!/usr/bin/env bash
# Meet-prep helper (DESIGN.md §7): pull every APPROVED ad artifact out of object storage
# into a local folder so the meet director can curate them for the scoreboard. LAN-side,
# read-only, no service — just `mc`. Downloads are LAN-only by design (no public GET path).
#
#   MINIO_URL=http://minio.lan:9000 \
#   MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
#   ./export-approved.sh [output-dir]
#
# Grabs objects named approved_* (the renamed, validated artwork). Defaults output to
# ./ads-<YYYY>-citymeet/.
set -euo pipefail

MINIO_URL="${MINIO_URL:-http://localhost:9000}"
: "${MINIO_ACCESS_KEY:?set MINIO_ACCESS_KEY (the scoped service account is fine)}"
: "${MINIO_SECRET_KEY:?set MINIO_SECRET_KEY}"
BUCKET="${MINIO_BUCKET:-gpsa-ads}"
OUT_DIR="${1:-./ads-$(date +%Y)-citymeet}"
ALIAS="gpsaads-export"

command -v mc >/dev/null || { echo "error: the MinIO client 'mc' is required on PATH" >&2; exit 1; }

mc alias set "$ALIAS" "$MINIO_URL" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
mkdir -p "$OUT_DIR"

echo ">> copying approved_* artwork from ${BUCKET} into ${OUT_DIR}"
mc find "$ALIAS/$BUCKET" --name 'approved_*' --exec "mc cp {} ${OUT_DIR}/"

echo ">> done:"
ls -1 "$OUT_DIR"
