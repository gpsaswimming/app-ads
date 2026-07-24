#!/bin/sh
# Render the nginx config at container start, then start nginx. The image is secret-free
# and environment-agnostic (DESIGN.md §7): the upstream is injected here from admin.env —
# nothing is baked in at build time. The admin container holds ZERO credentials.
set -eu

: "${API_UPSTREAM:?API_UPSTREAM is required (host:port of the Ads API)}"
# DNS resolver nginx uses to look up the API upstream lazily. Defaults to Docker's
# embedded DNS; set to the host/LAN resolver on a non-Docker-DNS deployment.
# Must be exported so envsubst substitutes it.
export RESOLVER="${RESOLVER:-127.0.0.11}"

# Inject only our vars; leave nginx's own $-vars intact.
envsubst '${API_UPSTREAM} ${RESOLVER}' \
  < /etc/gpsa/nginx.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
