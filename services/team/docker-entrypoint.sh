#!/bin/sh
# Render config at container start, then start nginx. The image is secret-free and
# environment-agnostic (DESIGN.md §7): the upstream + the public "resubmit" link are
# injected here from team.env — nothing is baked in. This container holds ZERO credentials;
# the trust boundary is the edge's email auth, which fronts this origin.
set -eu

: "${API_UPSTREAM:?API_UPSTREAM is required (host:port of the Ads API)}"
# Public submission form the "fix & resubmit" link points to.
export ADS_FORM_URL="${ADS_FORM_URL:-https://ads.gpsaswimming.org/}"
# DNS resolver nginx uses to look up the API upstream lazily. Defaults to Docker's embedded
# DNS; set to the host/LAN resolver on a non-Docker-DNS deployment. Must be exported so
# envsubst substitutes it.
export RESOLVER="${RESOLVER:-127.0.0.11}"

# Browser config — PUBLIC values only (never a secret).
envsubst '${ADS_FORM_URL}' \
  < /etc/gpsa/config.js.template > /usr/share/nginx/html/config.js

# nginx server config — inject only our vars; leave nginx's own $-vars intact.
envsubst '${API_UPSTREAM} ${RESOLVER}' \
  < /etc/gpsa/nginx.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
