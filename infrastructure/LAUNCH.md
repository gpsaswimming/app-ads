# LAUNCH runbook — Scoreboard Ads

The fastest path from this repo to a live intake form. The app is verified end-to-end;
what's left is **deploy + real credentials**. Two ways to get the images:

- **CI (normal):** push to `main` → `.github/workflows/build-images.yml` pushes
  `ghcr.io/gpsaswimming/app-ads-{web,proxy,api}` to GHCR. **Make each package Public once**
  (GHCR package → Settings → Change visibility) so the VMs pull with no `docker login`.
- **Rush (one host, no registry):** add `-f docker-compose.build.override.yml` to build locally.

## Credentials you must supply (nothing else is a decision)

| Value | Where | How to get it |
|---|---|---|
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` | web.env / ads-api.env | Cloudflare Turnstile → add site `ads.gpsaswimming.org` |
| `GEMINI_API_KEY` | ads-api.env | Google AI Studio API key (Gemini Flash) |
| `SMTP_URL` | ads-api.env | Any SMTP relay (e.g. Brevo): `smtp://user:pass@host:587` |
| `SUBMISSION_DEADLINE` | web.env **and** ads-api.env | This season's close date (ISO 8601), same in both |
| `GPSA_CHECK_ADDRESS` | ads-api.env | GPSA mailing address for the CHECK email |
| `ADS_NOTIFY_EMAIL` | ads-api.env | Ad-chair address for internal notifications |
| `UPLOAD_URL` / `ALLOW_ORIGIN` / `API_UPSTREAM` | web.env / proxy.env | Deploy hostnames (defaults already sensible) |

> Without a real `GEMINI_API_KEY` every ad still lands safely as `NEEDS_REVIEW` (fail-safe) —
> you can launch and add the key later; the AI check is advisory, never a hard gate.

## Bring-up

```bash
cd infrastructure
./generate-secrets.sh                       # writes the .env files (chmod 600)
# → fill the credentials above in ads-api.env / web.env / proxy.env

# Data tier
docker compose -f docker-compose.data.yml up -d
NC_ADMIN_PASSWORD='…' ./nocodb-setup.sh      # paste NOCODB_* into ads-api.env

# DMZ tier (brings up MinIO)
docker compose -f docker-compose.dmz.yml up -d      # add: -f docker-compose.build.override.yml --build  (rush)
MINIO_ROOT_USER=… MINIO_ROOT_PASSWORD=… ./minio-setup.sh   # paste MINIO_ACCESS/SECRET_KEY into ads-api.env

# App tier (ads-api.env now complete)
docker compose -f docker-compose.app.yml up -d      # add the override + --build for the rush path
```

## Edge (the last mile — your Traefik/tunnel)

| Public host | → | Container |
|---|---|---|
| `ads.gpsaswimming.org` | web `:8080` | serves the form + proxies `/api/*` |
| `ads-upload.gpsaswimming.org` | minio-proxy `:8082` | `POST /gpsa-ads` only |

Keep MinIO `:9000/:9001`, NocoDB, and `/internal/*` **off** the public edge (LAN/VPN only).

## Smoke test

Open `ads.gpsaswimming.org`, submit a test ad with a correctly-sized image → expect a
NocoDB row, the object in the bucket, and a confirmation email. Then you're live.

## Known fast-follow (not launch-blocking)

- **Flat landing zone + friendly export names.** Storage still uses `{uuid}/pending_…` with a
  `pending_→approved_` rename (works, tested). Simplify to a flat zone (DB `Status` is the
  source of truth) and move `<year>_<team>_<title>.<ext>` naming into `export-approved.sh`
  (join NocoDB on download) — do this before the meet-prep export, no rush for intake launch.
