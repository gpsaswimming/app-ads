# app-ads-web — DMZ static form + /api/* reverse proxy. Stock nginx, no baked-in
# config or secrets; everything is injected at container start by the entrypoint.
FROM nginx:alpine

# Static form assets. config.js is NOT copied — it is generated at container start.
COPY public/ /usr/share/nginx/html/

# Templates rendered by the entrypoint (envsubst) at container start.
COPY config.js.template nginx.conf.template /etc/gpsa/
COPY docker-entrypoint.sh /docker-entrypoint-gpsa.sh

# Drop the stock default server; ours is rendered to conf.d at start.
RUN chmod +x /docker-entrypoint-gpsa.sh \
    && rm -f /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

ENTRYPOINT ["/docker-entrypoint-gpsa.sh"]
