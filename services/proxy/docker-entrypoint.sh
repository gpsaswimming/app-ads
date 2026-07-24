#!/bin/sh
# Render the upload-proxy config at container start, then start nginx. The image is
# secret-free and environment-agnostic (DESIGN.md §7): the CORS origin is injected
# here from proxy.env — nothing is baked in. The proxy holds ZERO credentials.
set -eu

: "${ALLOW_ORIGIN:?ALLOW_ORIGIN is required (the form origin, e.g. https://ads.gpsaswimming.org)}"

# Inject only ${ALLOW_ORIGIN}; leave nginx's own $-variables intact.
envsubst '${ALLOW_ORIGIN}' \
  < /etc/gpsa/minio-proxy.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
