# Implementation Plan — app-ads

Sequenced build plan for the GPSA Scoreboard Ads platform. **The design is APPROVED** (2026-07-23,
see [`DESIGN.md`](DESIGN.md)). Build **one step at a time**; each step lists what to do, the files
it touches, which DESIGN.md sections to read first, and how to verify it. **Check off `[x]` as you
go** so a fresh session can resume exactly where the last left off.

> This repo is **public** — keep all docs and code self-contained; no references to other/private
> systems. Follow the parent portfolio conventions in `../CLAUDE.md` (shared CSS/assets CDN, brand
> colors, Inter, `node24` action majors for CI).

## Golden rules while building (DESIGN.md §3)

- **The Ads API is the only credentialed component.** The DMZ (web, upload proxy) holds **zero**
  secrets.
- **Images are secret-free and environment-agnostic.** Every secret/config value is injected at
  runtime via a per-service `.env` (§7); nothing is baked into an image or handed to CI.
- **Escape user input at every boundary** — parameterized NocoDB filters (no string interpolation),
  auto-escaped email templates (Eta `<%= %>`), `textContent`/`escapeHtml()` in the browser (never
  `innerHTML`).
- **Object keys are built server-side from the `Ad_ID` UUID**; size/type are enforced by the
  presign policy, not the client.
- **Verify Turnstile server-side before creating anything.**

---

## Phase 0 — Repo scaffold
- [ ] Create the structure: `web/`, `proxy/`, `services/ads-api/`, `infrastructure/`,
      `.github/workflows/`, `docs/` (this file + `DESIGN.md`).
- [ ] `.gitignore` — ignore `*.env` (keep `*.env.example`), `node_modules`, build output.
- [ ] `README.md` — one-paragraph overview + links to `docs/DESIGN.md` and this plan.
- [ ] Per-service `*.env.example` listing **every** key from DESIGN.md §7 with placeholder values.
- **Verify:** tree matches the layout in `CLAUDE.md`; `git status` shows no real `.env` tracked.

## Phase 1 — Ads API (`services/ads-api` → image `app-ads-api`) — everything depends on this
Read first: DESIGN.md §2 (flow), §3 (invariants), §4 (data model), §5 (validation), §9 (emails).
- [x] Fastify skeleton + `GET /health`; Dockerfile (node:alpine, non-root, healthcheck);
      `docker-compose.dev.yml` with `node --watch`.
- [x] Config loader — read + validate all §7 env vars at boot; **fail fast** if any required one is missing.
- [x] NocoDB client — REST via base/table IDs; **parameterized filters**; create/update `Ads` rows.
- [x] MinIO clients — internal SDK (renames) + presign client bound to the **public** upload host.
- [x] `POST /api/submit`:
  - [x] deadline check first → `403 SUBMISSIONS_CLOSED`
  - [x] Turnstile `siteverify` → `403` on fail (nothing created)
  - [x] JSON-schema validation (`additionalProperties:false`): `rights_confirmed===true`,
        `placement` enum, `payment_method` valid for affiliation, `content_type`/`byte_size`,
        and (if `submitter_is_advertiser`) `advertiser_*` == `submitter_*`
  - [x] create `Ads` row (`Ad_ID` UUID, `AWAITING_UPLOAD`); set `Payment_Amount` from `placement`
  - [x] generate presigned POST (bucket + `pending_` prefix + `content-length-range` + content-type)
        → return `{ ad_id, presign }`
- [x] `POST /internal/uploaded` (shared-secret header `MINIO_TO_API_SECRET`):
  - [x] ignore keys without `pending_`
  - [x] `VALIDATING`; record `Artwork_URI`/`Bytes`/`Content_Type`
  - [x] `sharp` dimension check vs `placement` (aspect ±1%, min dims) → `REJECTED` on fail
  - [x] Gemini appropriateness (flag offensive/adult + not-an-ad) → `NEEDS_REVIEW`; **fail-safe**
        to `NEEDS_REVIEW` on error/timeout
  - [x] on pass: rename `pending_`→`approved_`, status `APPROVED`
  - [x] send outcome email (submitter) + internal notification (`ADS_NOTIFY_EMAIL`)
- [x] Email — nodemailer + Eta (auto-escaped): approved (amount + payment instructions by method),
      rejected (reason), needs-review; internal one-line summary.
- **Verify:** unit-test submit/validate handlers; `curl /health`; a submit call returns a presign;
  simulate an `/internal/uploaded` event → correct status transitions + email captured (mailcatcher).
  **Done (2026-07-23):** 40 unit/integration tests pass (`npm test`) covering submit/validate +
  the full `/internal/uploaded` state machine with a fake mailer capturing outcome + internal
  emails; real server boots + `curl /health` → 200; the real MinIO client signs a presigned POST to
  `ads-upload.gpsaswimming.org/gpsa-ads`. Live MinIO/NocoDB/SMTP wiring lands with Phase 4 infra.

## Phase 2 — Web frontend (`web/` → image `app-ads-web`)
Read first: DESIGN.md §8 (form), §2 (flow), §1a (upload).
- [x] `public/` static form per §8 field order; shared GPSA CSS + Inter; brand colors;
      `max-w-7xl mx-auto`, `showToast()`, `escapeHtml()`.
- [x] Intro copy (venue + 50/50 split + pricing) verbatim; per-placement template download links
      (`assets.gpsaswimming.org/ad-templates/scoreboard-ad-{full,half}-screen.pptx`).
- [x] Behavior: "I am the advertiser" auto-fill; placement→price display; payment method by
      affiliation (team ⇒ read-only "pay your team"; GPSA ⇒ Check/Square Invoice); required rights
      checkbox; Turnstile widget (explicit render, public site key from `config.js`).
- [x] Two-step submit: POST metadata → `/api/submit`; on `{presign}` do the direct multipart POST
      to the presign URL (asserted to start with `UPLOAD_URL`); progress → success (Ad_ID + amount +
      how to pay).
- [x] Deadline-closed state (form checks injected `SUBMISSION_DEADLINE` at load; API 403 is backstop).
- [x] `nginx.conf` — serve static + reverse-proxy `/api/*` to the API host (`API_UPSTREAM`);
      `/internal/*` returns 404 at the DMZ.
- [x] Entrypoint `envsubst` injects `TURNSTILE_SITE_KEY` + `UPLOAD_URL` + `SUBMISSION_DEADLINE` into
      `config.js`, and `API_UPSTREAM` into `nginx.conf`, at container start; Dockerfile (nginx:alpine).
- **Verify:** run the web image against the dev API; submit a real test ad end-to-end.
  **Done (2026-07-23):** built `app-ads-web` and ran it on a shared network with the Phase 1 dev API.
  Confirmed: form served; `config.js` rendered with all three injected values (`no-store`); same-origin
  `/api/*` reverse-proxies to the API. Drove the submit path through the proxy — a valid body + passing
  test Turnstile clears deadline → Turnstile → schema → cross-validation and reaches the NocoDB write
  (fails only there, no DB in this harness), proving the form's JSON body matches the API contract;
  bad payment-method-for-team → cross-validation 400; past deadline → `403 SUBMISSIONS_CLOSED`;
  `/internal/uploaded` → 404 at the DMZ. **Not exercised (needs Phase 3/4 infra):** the real presigned
  upload landing in MinIO — the presign requires a live NocoDB row and the upload requires the
  Phase 3 proxy + MinIO. Interactive client behaviors (auto-fill, placement→price, closed-state render)
  are code-verified, not browser-driven.

> **Web-tier env note (deviation from §7):** the §7 web-env table lists only `TURNSTILE_SITE_KEY`,
> `UPLOAD_URL`. Phase 2 adds two more CONFIG (non-secret) values the DMZ genuinely needs and that the
> "environment-agnostic image" principle requires be injected, not baked: `SUBMISSION_DEADLINE` (so the
> form renders the closed state at load, per §8's "form is primary gate, API is backstop") and
> `API_UPSTREAM` (the App-tier host:port nginx proxies `/api/*` to). Both are documented in
> `web/web.env.example`.

## Phase 3 — Upload proxy (`proxy/` → image `app-ads-proxy`)
Read first: DESIGN.md §1a, §7 (`minio-proxy.conf` sketch).
- [x] `minio-proxy.conf` — `POST /gpsa-ads` only (405 other methods, 403 everything else), CORS for
      `ALLOW_ORIGIN`, `proxy_set_header Host $host`, `client_max_body_size 50m`.
- [x] Entrypoint `envsubst` `ALLOW_ORIGIN`; Dockerfile (nginx:alpine).
- **Verify:** a POST through the proxy lands in MinIO; GET/other methods → 403/405; console
  unreachable via the proxy.
  **Done (2026-07-23):** built `app-ads-proxy` and ran it against a real MinIO (private `gpsa-ads`
  bucket, `MINIO_SERVER_URL` = the public upload host). A presigned POST — generated by the API's own
  minio client, signed for the public host — pushed through the proxy returned **204** and the object
  landed in the bucket (`test-ad-uuid/pending_test.png`), with the `Access-Control-Allow-Origin`
  header on the response; **Host preservation** made the signature validate. Fence confirmed:
  `OPTIONS /gpsa-ads` → 204 (CORS preflight), `GET`/`PUT /gpsa-ads` → 405, `/`, `/gpsa-ads/<obj>`,
  and `/minio/health/live` (console/API) → 403. An anonymous POST with no presign is rejected by
  MinIO (400 `AuthorizationQueryParametersError`), confirming the proxy carries zero credentials.
  **Note:** MinIO is baked as the co-located DMZ service `minio:9000` (per the §7 single-stack
  model) — only `ALLOW_ORIGIN` is injected, matching §7's proxy.env exactly (no beyond-§7 vars, unlike
  the web tier's cross-VM `API_UPSTREAM`).

## Phase 4 — Infrastructure & provisioning (`infrastructure/`)
Read first: DESIGN.md §7 (compose, config/secrets), §4 (bucket + schema).
- [x] Per-tier `docker-compose.yml` (DMZ / App / Data) with `env_file` per service, volumes, and the
      MinIO webhook env (`docker-compose.{dmz,app,data}.yml` + `minio.env.example`, `nocodb.env.example`).
- [x] MinIO setup script (`minio-setup.sh`): create `gpsa-ads` (private, no public ACL), lifecycle rule
      (30d), ObjectCreated webhook → API, and a **scoped service account** → `ads-api.env`.
- [x] NocoDB provision script (`nocodb-setup.sh`): create the base + `Ads` table (fields/enums per §4) →
      print `NOCODB_BASE_ID` / `NOCODB_ADS_TABLE_ID` (+ token) for `ads-api.env`.
- [x] `generate-secrets.sh` — populate the `S` values across the `.env` files; `chmod 600`.
- [x] Optional `mc` bulk-export helper (`export-approved.sh`, §7) for the meet director.
- **Verify:** `docker compose up` per tier on a test host; the MinIO webhook reaches the API; a
  submit produces a NocoDB row and a `pending_` object.
  **Done (2026-07-23):** stood up the whole system locally (real images + real `*.env` from
  `generate-secrets.sh` + the real setup scripts) against live NocoDB (2026.07.0) + MinIO + a Mailpit
  sink. `nocodb-setup.sh` created the base + `Ads` table (all §4 fields/enums) + an API token;
  `minio-setup.sh` created the private bucket, subscribed `s3:ObjectCreated:*` → `arn:minio:sqs::ADS:webhook`,
  added the `state=pending`/30d lifecycle rule, and minted a bucket-scoped service account. A real
  submit: `POST /api/submit` (test Turnstile) → NocoDB row `AWAITING_UPLOAD` (payment CHECK, $75) +
  presign signed by the scoped svcacct → upload **through the proxy → 204** → `pending_` object in the
  bucket → **MinIO ObjectCreated webhook authenticated and reached `/internal/uploaded`** → dims
  validated (2700×1200 recorded) → Gemini failed on the dummy key → **fail-safe `NEEDS_REVIEW`** →
  both emails captured in Mailpit (submitter outcome + internal ad-chair notification). The
  `APPROVED` + `pending_→approved_` rename branch needs a real `GEMINI_API_KEY` (Phase 6 deploy value).
  **Script hardening from the verify:** `minio-setup.sh` parses the svcacct with grep (mc-only, no
  python dep); `nocodb-setup.sh` JSON helpers keep the program in `-c` so piped data owns stdin and
  tolerate non-JSON error bodies.

> **Lifecycle caveat:** keys are `{ad_uuid}/pending_{file}` (not a root prefix), so the 30-day cleanup
> is a **tag-based** rule (`state=pending`), inert until pending objects carry that tag — a small
> Ads-API follow-up (tag on upload, drop on the `approved_` rename). Documented in
> `infrastructure/README.md`; nothing else depends on it.

## Phase 5 — CI/CD (`.github/workflows/`)
Read first: DESIGN.md §7; portfolio `../CLAUDE.md` (pinned `node24` action majors).
- [ ] Workflow: on push to `main`, build + push the **3 images** to GHCR as **public** packages
      (built-in `GITHUB_TOKEN`, `permissions: packages: write`). No app secrets in CI.
- [ ] Tag `:latest` + commit SHA.
- **Verify:** a push yields 3 public images pullable with no `docker login`.

## Phase 6 — Edge & end-to-end
Read first: DESIGN.md §7 (domains / traffic model).
- [ ] Operator wires edge routing: `ads.gpsaswimming.org` → web; `ads-upload.gpsaswimming.org` →
      proxy; MinIO/NocoDB/`/internal/*` kept off the public edge; inter-tier firewall per the §7
      traffic model.
- [ ] Supply deploy-time values (§10): `SUBMISSION_DEADLINE`, `ADS_NOTIFY_EMAIL`, GPSA check mailing
      address, and the Turnstile/Gemini/SMTP credentials.
- [ ] Production smoke test: submit → validate → email → `approved_` object in bucket → meet
      director LAN download.

---

## Deferred (do NOT build now) — DESIGN.md §12
- Meet-selection dropdown (2027+). The `Ads.Meet` field already exists; leave it config-set for the
  single 2026 City Meet.
