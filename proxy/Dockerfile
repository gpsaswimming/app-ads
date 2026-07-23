# app-ads-proxy — DMZ upload-only fence in front of MinIO. Stock nginx, no baked-in
# secrets; the CORS origin is injected at container start by the entrypoint.
FROM nginx:alpine

# Config template rendered by the entrypoint (envsubst) at container start.
COPY minio-proxy.conf.template /etc/gpsa/
COPY docker-entrypoint.sh /docker-entrypoint-gpsa.sh

# Drop the stock default server; ours is rendered to conf.d at start.
RUN chmod +x /docker-entrypoint-gpsa.sh \
    && rm -f /etc/nginx/conf.d/default.conf

EXPOSE 8080

# Healthy = the deny-all default rule is live (nginx up and serving our config).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -S -O /dev/null http://127.0.0.1:8080/ 2>&1 | grep -q "403 Forbidden" || exit 1

ENTRYPOINT ["/docker-entrypoint-gpsa.sh"]
