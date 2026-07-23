# Infrastructure & provisioning

Per-tier Docker Compose stacks and setup scripts for deploying the GPSA Scoreboard Ads
platform (DESIGN.md §7). One stack per VM/tier; the browser only ever touches the DMZ.

## Layout

| File | Runs on | What it brings up / does |
|---|---|---|
| `docker-compose.dmz.yml` | DMZ VM | `web` + `minio-proxy` + `minio` |
| `docker-compose.app.yml` | App VM | `ads-api` (the only credentialed component) |
| `docker-compose.data.yml` | Data VM | `nocodb` (no internet egress; admin UI VPN-only) |
| `minio-setup.sh` | DMZ (LAN) | private `gpsa-ads` bucket + ObjectCreated webhook + pending-cleanup rule + scoped service account |
| `nocodb-setup.sh` | Data (LAN) | creates the base + `Ads` table (fields/enums per §4) + an API token |
| `generate-secrets.sh` | anywhere | fills the per-tier `.env` files from the `*.env.example` templates |
| `export-approved.sh` | LAN | meet-prep: pull `approved_*` artwork into a local folder |

Images are pulled from GHCR as **public** packages (Phase 5 builds + pushes them), so the
VMs need no registry credential. Each `.env` is git-ignored and `chmod 600`; the committed
`*.env.example` files document every key. `web`/`minio-proxy` env examples live with their
images (`../web/`, `../proxy/`); `ads-api.env.example` lives in `../services/ads-api/`.

## Bring-up order

```bash
# 0. Generate the .env files, then fill the deploy/account values they leave as changeme-*.
./generate-secrets.sh

# 1. Data tier, then provision NocoDB → paste NOCODB_* into ads-api.env
docker compose -f docker-compose.data.yml up -d
NC_ADMIN_PASSWORD='…' ./nocodb-setup.sh

# 2. DMZ tier (brings up MinIO), then provision it → paste MINIO_ACCESS/SECRET_KEY into ads-api.env
docker compose -f docker-compose.dmz.yml up -d
MINIO_ROOT_USER=… MINIO_ROOT_PASSWORD=… ./minio-setup.sh

# 3. App tier (now that ads-api.env is complete)
docker compose -f docker-compose.app.yml up -d
```

The edge/tunnel then fronts `web` as `ads.gpsaswimming.org` and `minio-proxy` as
`ads-upload.gpsaswimming.org`; MinIO `:9000/:9001`, NocoDB, and `/internal/*` stay off the
public edge (see §7 traffic model + Phase 6).

## Two wiring facts that must line up

- **Shared webhook secret.** `minio.env`'s `MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_ADS` **must
  equal** `ads-api.env`'s `MINIO_TO_API_SECRET` — the API rejects the ObjectCreated webhook
  otherwise. `generate-secrets.sh` sets both to the same generated value.
- **Presign host.** MinIO runs with `MINIO_SERVER_URL=https://ads-upload.gpsaswimming.org`
  and the proxy preserves `Host`, so presigned-POST signatures validate.

## Note — pending-cleanup lifecycle rule

Object keys are `{ad_uuid}/pending_{file}` and become `{ad_uuid}/approved_{file}` on
approval, so a plain path-prefix lifecycle rule can't isolate the pending ones.
`minio-setup.sh` instead adds a **tag-based** expiry (`state=pending`, 30 days). It is inert
— and safe — until pending objects actually carry that tag, which is a one-line addition to
the presign policy (tag on upload) and the `pending_→approved_` rename (drop the tag). Track
this as a small Ads-API follow-up if automatic cleanup is wanted; nothing else depends on it.
