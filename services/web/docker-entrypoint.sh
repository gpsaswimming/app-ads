#!/bin/sh
# Render runtime config into the image at container start, then start nginx.
# The image is secret-free and environment-agnostic (DESIGN.md §7): every value is
# injected here from the per-VM web.env — nothing is baked in at build time.
set -eu

: "${TURNSTILE_SITE_KEY:?TURNSTILE_SITE_KEY is required}"
: "${UPLOAD_URL:?UPLOAD_URL is required}"
: "${SUBMISSION_DEADLINE:?SUBMISSION_DEADLINE is required}"
: "${API_UPSTREAM:?API_UPSTREAM is required (host:port of the Ads API)}"
# DNS resolver nginx uses to look up the API upstream lazily. Defaults to Docker's
# embedded DNS; set to the host/LAN resolver on a non-Docker-DNS deployment.
# Must be exported so envsubst substitutes it.
export RESOLVER="${RESOLVER:-127.0.0.11}"

# Browser config — PUBLIC values only (site key, upload host, deadline). Never a secret.
envsubst '${TURNSTILE_SITE_KEY} ${UPLOAD_URL} ${SUBMISSION_DEADLINE}' \
  < /etc/gpsa/config.js.template > /usr/share/nginx/html/config.js

# nginx server config — inject only our vars; leave nginx's own $-vars intact.
envsubst '${API_UPSTREAM} ${RESOLVER}' \
  < /etc/gpsa/nginx.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
