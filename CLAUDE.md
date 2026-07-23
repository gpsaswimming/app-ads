# CLAUDE.md — app-ads (GPSA Scoreboard Ads)

Guidance for Claude Code when working in this repo. Also follow the GPSA portfolio
conventions in the parent `../CLAUDE.md` (shared CSS/assets CDN, brand colors, Inter font,
team abbreviations).

## Project

A submission platform for **digital scoreboard advertisements** displayed during City Meet
warm-ups and award breaks. Sponsors/teams submit a high-resolution **photo** (no video) in one of
two placements — **full-screen (18×8″, 9:4)** or **half-screen (9×8″, 9:8)**.

## Status: design APPROVED (2026-07-23) — build in progress

**Build one component at a time, following the checklist in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).**
Check off steps as you go so a fresh session resumes cleanly. **Read the relevant `docs/DESIGN.md`
section before building each component**, and honor the invariants below throughout.

> This is a **public-facing repo** — keep all docs and code self-contained. Do not reference
> other/private systems or frame decisions as differences from them.

## Development workflow — ground rules

- **Never commit directly to `main`.** All work goes on a **feature branch** and lands via a
  **pull request** to `main`. No exceptions.
- **Branch naming:** `feat/<component>` (e.g. `feat/ads-api`), `docs/<topic>`, `fix/<topic>`,
  `chore/<topic>`.
- **One logical change per PR** — keep them reviewable; align a PR with an `IMPLEMENTATION.md`
  phase where practical.
- Open the PR against `main`; don't self-merge without the review step the PR exists to provide.
- Commit messages: imperative summary + why. Do not commit `.env` files or any secret.

## Architecture — three tiers, browser touches DMZ only

| Tier | Holds | Internet egress |
|---|---|---|
| DMZ | nginx (static form + reverse-proxy `/api/*`) · **minio-proxy** (upload-only) · MinIO | no |
| Application | **Ads API** (Node.js / Fastify) — sole credentialed component | **yes** (Gemini, SMTP) |
| Data | NocoDB only (VPN-only admin UI) | **no** |

**End-user only ever touches DMZ** (nginx + minio-proxy). The credentialed Ads API, NocoDB, and
MinIO's own ports are never directly internet-exposed. The DMZ proxies hold zero credentials.

**MinIO exposure — three paths, one public:**
- **Public (edge):** browser → `minio-proxy` → MinIO, **`POST /gpsa-ads` only** (all else
  403/405). minio-proxy holds zero creds, sets CORS for the form origin, preserves `Host`.
- **Internal (App):** Ads API SDK → MinIO :9000 (presign-target host + `pending_`→`approved_` rename).
- **LAN only:** you / scoreboard operator → MinIO :9000/:9001 for downloads + console. **No
  public GET path.** Presign is generated against the public upload host; MinIO started with
  `MINIO_SERVER_URL=https://ads-upload.gpsaswimming.org` so signatures validate.

Flow: same-origin `POST /api/submit` (nginx→API) verifies Turnstile + validates + writes NocoDB
row + returns a presigned POST → browser uploads photo to `ads-upload.gpsaswimming.org`
(minio-proxy, POST-only) → MinIO → ObjectCreated → `POST /internal/uploaded` → API validates
dimensions (`sharp`) + Gemini appropriateness check → APPROVED / REJECTED / NEEDS_REVIEW +
email. Admin reviews + marks payment in NocoDB; operator downloads approved ads on the LAN.

## Key decisions (see DESIGN.md)

1. **Ads API is the workhorse — no workflow engine deployed for MVP.** Only async seam:
   `MinIO ObjectCreated → POST /internal/uploaded`. Don't add one unless a non-dev must edit
   email/rules without a deploy.
2. **Ads API lives in the Application tier, not with the DB** — it needs internet egress (Gemini,
   SMTP); NocoDB stays alone in the Data tier with no egress. *(Locked 2026-07-23, §1b Option A.)*
3. **Google Gemini (Flash) performs the appropriateness check** — advisory only, flips to
   `NEEDS_REVIEW`, never auto-reject; fail safe (NEEDS_REVIEW) on error.
4. **Containers, one VM per tier, each running Docker; 3 custom images via GHCR** (`app-ads-api`,
   `app-ads-web`, `app-ads-proxy` — form/config baked in, not bind-mounted; MinIO+NocoDB official).
   Dedicated instances + credentials; VM sizing/hardware left to the implementer. Outbound traffic
   is not policed at the app level — the operator owns firewall rules (design gives a node-to-node
   traffic model, not rules).
5. **Frontend self-hosted nginx in the DMZ** → same-origin `/api/*`, no CORS.

## Non-negotiable invariants (see DESIGN.md §3)

1. **End-user only touches DMZ** (nginx + minio-proxy); API, NocoDB, and MinIO's ports never
   directly internet-reachable.
2. **DMZ proxies hold zero credentials** (nginx serves static + proxies `/api/*`; minio-proxy
   forwards only `POST /gpsa-ads`). MinIO's public surface is that one op; console + downloads
   are LAN-only; no public presigned-GET.
3. **The Ads API is the only credentialed component** — MinIO keys, NocoDB token, Turnstile
   secret, SMTP, `GEMINI_API_KEY` live only in its `.env`.
4. **Verify Turnstile server-side before creating anything.** No token → 403, no row, no presign.
5. **Size/type enforced by the MinIO presign policy**, never trusted from the client.
6. **MinIO keys built server-side from the `Ad_ID` UUID**; sanitize the original filename.
7. **`/internal/*` not publicly routable**; MinIO→API webhook carries `MINIO_TO_API_SECRET`.
8. **NocoDB never publicly routed; admin UI VPN-only.** Only the App-tier API makes outbound
   calls (Gemini/SMTP); data tier has none by design. Firewall enforcement is the operator's, not
   policed at app level.
9. **Escape user input at every boundary** — NocoDB `filterExpr()`, Eta auto-escaped email,
   `textContent`/`escapeHtml()` in the browser (never `innerHTML`).
10. **Cleartext internal HTTP between tiers** for inter-tier firewall DPI; TLS terminates at the
    edge only.
11. **`gpsa-ads` bucket fully private.**

## Artwork spec (DESIGN.md §5)

Two placements: FULL_SCREEN **18×8″ (9:4)** and HALF_SCREEN **9×8″ (9:8)**. Recommended PNG export
at 150 DPI: full 2700×1200, half 1350×1200. Validate aspect ±1% + min dims per placement. Photos
only (PNG/JPG); no video. Then Gemini appropriateness check.

## Not in scope

No accounts, magic links, or sessions (the form is public); no per-user auth beyond Turnstile; no
workflow engine; no local AI. Do not introduce them.

## Layout (planned — build only after approval)

```
app-ads/
├── docs/DESIGN.md                     ← the design / source of truth (read the relevant section first)
├── docs/IMPLEMENTATION.md             ← sequenced build checklist — resume here each session
├── web/                               ← app-ads-web image: public/ (form) + nginx.conf + Dockerfile
├── proxy/                             ← app-ads-proxy image: minio-proxy.conf + Dockerfile
├── services/ads-api/                  ← app-ads-api image: Fastify (/api/submit, /internal/uploaded, /health) + Dockerfile
├── infrastructure/docker-compose.yml  ← per-tier stacks (DMZ / App / Data), dedicated VM
└── .github/workflows/                 ← CI: build + push the 3 images to GHCR
```

## Deploy-time values to supply (DESIGN.md §10)

All design decisions are resolved. Remaining are deploy-time values, not design work:
`SUBMISSION_DEADLINE` (season date), `ADS_NOTIFY_EMAIL` (ad-chair address), GPSA check mailing
address (email template), and Turnstile/Gemini/SMTP credentials.
