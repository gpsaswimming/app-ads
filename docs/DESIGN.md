# GPSA Scoreboard Ads — Platform Design

**Status:** ✅ **APPROVED — 2026-07-23.** Implementation proceeds one component at a time per §11
and the sequenced checklist in [`IMPLEMENTATION.md`](IMPLEMENTATION.md).
**Subdomain:** `ads.gpsaswimming.org` · **Repo:** [github.com/gpsaswimming/app-ads](https://github.com/gpsaswimming/app-ads)

A submission platform for **digital scoreboard advertisements** shown on the City Meet
scoreboard during warm-ups and award breaks. Sponsors and teams submit a high-resolution
**photo** (no video) in one of two placements — **full-screen (18×8″, 9:4)** or
**half-screen (9×8″, 9:8)**. Artwork is stored in object storage (MinIO); submission metadata
(submitter, team, company, placement, payment status) lives in a metadata database (NocoDB); a
small **Ads API** does the orchestration work (bot verification, upload authorization, image
validation, appropriateness check, email).

Submissions are **public ad content the submitter wants published**, so there is no per-user
authentication — the form is open, and abuse is handled by **Cloudflare Turnstile** (bot gate)
plus **admin review**. Sensitive artwork never needs protecting; the security effort instead
goes toward keeping the credentialed components off the public internet and enforcing exactly
what the public may do (submit metadata; upload one file).

## Key design decisions

- **A single Ads API is the workhorse.** One Node.js/Fastify service handles the synchronous hot
  path (verify → authorize upload → create record) *and* the async side-effects (image
  validation, appropriateness check, email). No separate workflow engine is deployed for MVP (§6).
- **The end-user only ever touches DMZ-tier components** — the static form/`/api` proxy and the
  upload-only object-storage proxy. The credentialed Ads API, the database, and object storage's
  own ports are never directly internet-exposed (§1).
- **Object storage is fenced behind an upload-only proxy** (§1a). The public surface is a single
  `POST /gpsa-ads`. Everything else (console, listing, downloads) is internal- or LAN-only.
  **Downloads happen only on the local network** — there is no public read path.
- **The Ads API lives in the application tier**, separate from the database. It makes outbound
  calls (Gemini, SMTP), so it belongs in the egress-capable tier; the database stays in the
  deepest tier with **no internet egress** (§1). *(Locked 2026-07-23 — see §1b.)*
- **Google's Gemini API performs the appropriateness check.** Advisory only → flips a submission
  to `NEEDS_REVIEW`, never an auto-reject (§5).
- **Deployed as containers — recommended one VM per tier, each running Docker.** Three custom
  images (Ads API, web/form, upload proxy) are built in CI and published to GHCR; MinIO and NocoDB
  use official images. VM sizing and hardware are the implementer's call; the design fixes only
  which service lives in which tier (§7).

---

## 1. Architecture — three tiers, browser touches the DMZ only

The system is split into three network tiers separated by an inter-tier firewall performing deep
packet inspection. Traffic between tiers is cleartext HTTP so the firewall can inspect it; TLS
terminates at the internet edge only.

```
                    Cloudflare (Turnstile) + edge reverse proxy (Traefik + CrowdSec, WireGuard tunnel)
                                       │  HTTPS terminates at edge
  ═════════════════════════════════════╪══════════════════════════════════════ DMZ tier
        browser only ever talks         ▼
        to this row →   ┌──────────────────────┐   ┌──────────────────────────────┐
                        │ nginx                 │   │ minio-proxy (nginx/Caddy)     │
                        │ ads.gpsaswimming.org  │   │ ads-upload.gpsaswimming.org    │
                        │ • serves static form  │   │ • POST /gpsa-ads ONLY          │
                        │ • reverse-proxy /api/*│   │ • CORS for form origin         │
                        │ • zero creds          │   │ • all else → 403/405; 0 creds  │
                        └──────────────────────┘   └──────────────┬───────────────┘
                               │ /api/* →                         │ POST only
                               │                                  ▼
                               │                    ┌──────────────────────────────┐
                               │                    │ MinIO (S3 :9000, console :9001)│
                               │                    │ gpsa-ads/{ad_uuid}/...          │
                               │                    │ :9000 internal + LAN only       │
                               │                    │ :9001 LAN only (never routed)   │
                               │                    └──────────────────────────────┘
                               │                          ▲ SDK (presign host + rename)
                               │                          │        ▲ (4) ObjectCreated webhook
  ═══════════ inter-tier firewall (DPI on cleartext HTTP) ╪════════╪══════════════ Application tier
                               ▼                          │        │
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  Ads API  (Node.js / Fastify)   — the ONLY credentialed component           │
   │  POST /api/submit        verify Turnstile → validate → DB record → presign   │
   │  POST /internal/uploaded (from MinIO) dims + Gemini check → rename → email    │
   │  GET  /health                                                                │
   │  holds: MinIO keys · NocoDB token · Turnstile secret · SMTP · GEMINI_API_KEY  │
   │  egress → Gemini API (generativelanguage.googleapis.com), SMTP relay          │
   └───────────────────────────────────────────────────────────────────────────┘
                                       │ REST (parameterized)
  ═══════════════════════════ inter-tier firewall ═════════════════════════════ Data tier
                                       ▼
                          ┌──────────────────────────┐
                          │ NocoDB (metadata/state)  │  no internet egress; inbound App-tier only
                          │ admin UI — VPN only       │
                          └──────────────────────────┘

  LAN (local network only, NOT via edge):  meet director → MinIO :9000/:9001
                                            = download approved ads + console/admin
```

> Tier boundaries map to separate VLANs at deployment; the specific VLAN IDs are a deployment
> detail and are not fixed by this design.

**End-user reaches only the DMZ row** (the static form's nginx + the upload proxy). The
credentialed Ads API, the database, and object storage's own ports are never directly
internet-exposed.

### The DMZ proxy layer holds zero credentials

The browser exchanges JSON with the API and uploads a binary file to object storage — nothing
in the DMZ needs to render data or hold secrets. So the DMZ is two thin, credential-free proxies:

- **nginx** serves the static form and reverse-proxies `/api/*` to the Ads API (a `location
  /api/` block, no secrets).
- **minio-proxy** forwards a single `POST /gpsa-ads` to object storage (§1a).

A full compromise of the DMZ yields no credentials and no direct database or storage access.

### 1a. Object-storage exposure model — three paths, one public

| Path | Actor | Reaches | Allowed operations |
|---|---|---|---|
| **Public (edge)** | Browser (presigned upload) | `minio-proxy` → MinIO :9000 | **`POST /gpsa-ads` only**; all other methods/paths → 403/405; console never routed |
| **Internal (App)** | Ads API SDK | MinIO :9000 directly | presign-target host + `pending_`→`approved_` rename/copy |
| **LAN only** | You / scoreboard operator | MinIO :9000 / :9001 directly | download approved artwork + console/admin |

- The **`minio-proxy`** (a small nginx/Caddy container, config in-repo) is the *only* thing the
  edge routes to for object storage. It exposes exactly one verb+path and holds **zero
  credentials** (the browser carries the presigned policy + signature; the proxy just forwards).
- **Signing host:** the Ads API generates the presign against the **public upload host**
  (`https://ads-upload.gpsaswimming.org`); the proxy **preserves the `Host` header**. A presigned
  POST signature is **host-independent**, so MinIO's own `MINIO_SERVER_URL` is set to its **LAN**
  API address — using the fenced public host is unnecessary and **breaks the Console login**.
  The API's internal SDK client (renames) uses the internal host and is unaffected.
- **CORS** is answered by the proxy (the upload host is a different subdomain from the form):
  `Allow-Origin: https://ads.gpsaswimming.org`, `Allow-Methods: POST, OPTIONS`. Object storage
  stays CORS-dumb.
- **No public read.** Downloads are LAN-only (console/`mc`), so no presigned-GET surface exists.
- Prefer a purpose-built minimal container over a UI-driven reverse-proxy manager, so the
  method/path allow-list is reviewed, version-controlled config — not UI state.

### 1b. Open decision — Ads API tier placement

The Ads API both **talks to the database** (argues for the deepest tier) and **makes outbound
internet calls** to Gemini + SMTP (argues for the egress-capable application tier). The two pull
in opposite directions. Two viable layouts:

| | **A — App tier (recommended)** | **B — co-located with the DB** |
|---|---|---|
| API location | Application tier | Data tier, same node as the database |
| DB reachability | DB listens for the App tier across one firewall boundary | DB never on a VLAN — reachable only via localhost bridge (strongest DB isolation) |
| Internet egress origin | Application tier (kept away from data at rest) | **Data tier** — the deepest zone now makes outbound calls to Google/SMTP |
| Firewall hops per request | one more (App→Data) | fewer |
| Trade | Slightly larger DB exposure (listens on a tier interface) | Egress from the crown-jewel zone; collapses the 3-tier design toward 2 |

**DECISION — Option A (locked 2026-07-23).** The Ads API sits in the application tier; the
database stays isolated and egress-free in the deepest tier, reached across one firewall
boundary. Keeping internet egress out of the data tier is worth the extra hop.

### Component inventory

| Component | Tier | Tech | Role |
|---|---|---|---|
| nginx | DMZ | nginx | Serves static form + reverse-proxies `/api/*`. Zero credentials. |
| minio-proxy | DMZ | nginx/Caddy | Upload-only fence in front of object storage: `POST /gpsa-ads` + CORS. Zero credentials. |
| MinIO | DMZ | MinIO (Docker) | Private ad-artwork store. Public surface only via minio-proxy; :9000 internal+LAN, :9001 LAN-only. |
| Ads API | App | Node.js / Fastify | Turnstile verify, presign, dimension validation, Gemini check, email, DB writes. **Sole credential holder.** Internet egress (Gemini, SMTP). |
| NocoDB | Data | NocoDB (Docker) | Metadata + state + payment. No internet egress. Admin UI VPN-only. |
| Edge | Cloud VPS | Traefik + CrowdSec + WireGuard tunnel | HTTPS termination, L7 DoS protection, tunnel to the on-prem tiers. |
| Inter-tier firewall | — | Palo Alto (PA-440) | Gatekeeper between tiers; DPI on cleartext internal HTTP. |

> **Deployment isolation:** this is a public, internet-facing intake app. It runs on **dedicated
> infrastructure** — its own object-storage and database instances, its own credentials, its own
> VM — never co-tenanted with unrelated systems. See §7.

> **Object-storage portability:** the design depends only on the S3 presigned-POST +
> object-created-event contract, so a hosted S3-compatible store (e.g. Cloudflare R2) is a
> drop-in alternative to self-hosted MinIO; only the endpoint and the event-notification
> mechanism change. MinIO is the chosen default.

---

## 2. Submission flow (happy path)

1. **Load form.** Browser loads `ads.gpsaswimming.org` (nginx, DMZ). The Turnstile widget renders
   and yields a token on pass.
2. **Submit metadata.** Form POSTs JSON **same-origin** to `/api/submit`; nginx proxies it across
   the firewall to the Ads API (App tier):
   `{ submitter_name, submitter_email, submitter_phone?, submitter_is_advertiser, company_name,
   advertiser_name, advertiser_email, advertiser_phone?, team, ad_title, placement,
   payment_method, rights_confirmed, filename, content_type, byte_size, turnstile_token }`.
   **No file yet.** (When `submitter_is_advertiser` is true the form fills `advertiser_*` from
   `submitter_*`. `Payment_Amount` is not sent by the client — the API derives it from `placement`.)
3. **API gate + presign.** The Ads API:
   - **if past `SUBMISSION_DEADLINE` → `403 SUBMISSIONS_CLOSED`** (checked first, before anything
     else — a stale page can't sneak in a late submission);
   - verifies `turnstile_token` via Cloudflare `siteverify` (reject → `403`, nothing created);
   - validates fields (Fastify JSON-schema, `additionalProperties:false`): requires
     `rights_confirmed === true`, `placement ∈` {`FULL_SCREEN`, `HALF_SCREEN`}, `content_type ∈`
     {`image/png`, `image/jpeg`}, `byte_size ≤` cap; `payment_method` valid for the affiliation
     (a team ⇒ `PAY_TEAM`; `GPSA` ⇒ `CHECK`|`SQUARE_INVOICE`); if `submitter_is_advertiser` the
     `advertiser_*` values must equal the `submitter_*` values; then the API sets `Payment_Amount`
     from `placement`;
   - creates a NocoDB `Ads` row with a fresh `Ad_ID` (UUID), `Status = AWAITING_UPLOAD`;
   - generates a **presigned POST** against the **public upload host**, scoped to
     `gpsa-ads/{ad_uuid}/pending_{filename}` with `content-length-range` + `Content-Type`
     conditions — the real, storage-enforced size/type gate;
   - returns `{ ad_id, presign }`.
4. **Direct upload.** Browser POSTs the file to `ads-upload.gpsaswimming.org` → minio-proxy
   (POST-only) → object storage (DMZ). Large photos never pass through the API.
5. **Validate.** Object storage fires `s3:ObjectCreated` → `POST /internal/uploaded` on the Ads
   API (shared-secret header `MINIO_TO_API_SECRET`; the API ignores keys not containing
   `pending_`):
   - set `Status = VALIDATING`, record `Artwork_URI`, `Artwork_Bytes`, `Content_Type`;
   - read dimensions in-process (`sharp`); compare to the placement's spec (§5);
   - if dimensions fail → `Status = REJECTED`, email the reason (resubmit = new `Ad_ID`);
   - else call **Gemini** for an appropriateness check;
     - appropriate → rename `pending_`→`approved_`, `Status = APPROVED`, confirmation email;
     - flagged/uncertain/error → `Status = NEEDS_REVIEW` for a human;
6. **Admin.** Admin opens NocoDB (VPN), reviews `NEEDS_REVIEW`, sets `Payment_Status`.
7. **Meet prep.** Before the meet, the **meet director** downloads the approved artwork **on the
   LAN** (console/`mc`, or the optional bulk-export helper in §7) and curates/touches it up for
   the scoreboard. The platform's responsibility ends at "approved files, easy to grab."

---

## 3. Security invariants

1. **The end-user only ever touches DMZ components** (the static-form nginx + the upload proxy).
   The Ads API, the database, and object storage's own ports are never directly reachable from
   the internet.
2. **The DMZ proxies hold zero credentials.** nginx serves static + proxies `/api/*`; minio-proxy
   forwards a single `POST /gpsa-ads`. A DMZ compromise yields no secrets and no DB access.
3. **Object storage's public surface is exactly one operation.** `POST /gpsa-ads` via minio-proxy;
   all other methods/paths → 403/405; the console (:9001) is never routed to the edge; downloads
   are LAN-only. No public read path exists.
4. **The Ads API is the only credentialed component.** Object-storage keys, DB token, Turnstile
   secret, SMTP creds, and `GEMINI_API_KEY` live only in its `.env` (chmod 600). The frontend
   ships only the public Turnstile *site* key.
5. **Verify Turnstile server-side before creating anything.** Invalid/missing → `403`, no record,
   no presign.
6. **Size and type are enforced by the presign policy, not the client.** `content-length-range`
   + `Content-Type` are evaluated by object storage. The client `byte_size` only drives a
   friendly early error.
7. **Object keys are built server-side from the `Ad_ID` UUID**, never from raw user input; the
   original filename is sanitized before it is appended.
8. **`/internal/*` is not publicly routable** — only `/api/*`, the static site, and the
   upload-only proxy are exposed. The storage→API webhook path is internal and carries
   `MINIO_TO_API_SECRET`.
9. **The database is never publicly routed; its admin UI is VPN-only.** The only components that
   call the internet are on the App tier (Gemini, SMTP) — the database and object storage make no
   outbound internet calls by design. (Firewall enforcement of this is the operator's call; the
   architecture simply doesn't route data-tier traffic outward.)
10. **Escape user input at every boundary.** DB `where` clauses → parameterized filter helpers
    (no string interpolation); browser rendering of submitter/company text →
    `textContent`/`escapeHtml()`, never `innerHTML`. Emails are **text/plain**, so there is no
    markup to escape — HTML-escaping them would corrupt the visible body (turning quotes/`&` into
    `&quot;`), and the only injection vector, the headers, is handled by nodemailer. A value safe
    today may be unsafe tomorrow — escaping is structural, not conditional on current content.
11. **Cleartext internal HTTP between tiers** so the inter-tier firewall can perform full DPI on
    inter-tier calls. TLS terminates at the edge only.
12. **The `gpsa-ads` bucket is fully private** (no public ACL).

---

## 4. Data model

### NocoDB — Table: `Ads`

| Field | Type | Notes |
|---|---|---|
| `Ad_ID` | UUID (PK) | `crypto.randomUUID()`; also the object-key prefix. Never in a public URL. |
| `Meet` | Text | e.g. `"2026 City Meet"`. Set by config today (one meet per season); a user-facing meet dropdown is a future enhancement (§12). |
| `Submitter_Name` | Text | Required. Whoever fills out the form. |
| `Submitter_Email` | Email | Required. Confirmation/rejection emails go here. |
| `Submitter_Phone` | Text | Optional. |
| `Submitter_Is_Advertiser` | Checkbox | Form shortcut "I am the advertiser." When true, the advertiser fields are copied from the submitter (no re-entry). |
| `Company_Name` | Text | Required. The advertiser business. |
| `Advertiser_Name` | Text | Advertiser's contact person. Equals `Submitter_Name` when `Submitter_Is_Advertiser` is true. |
| `Advertiser_Email` | Email | Advertiser's contact email. Equals `Submitter_Email` when `Submitter_Is_Advertiser` is true. |
| `Advertiser_Phone` | Text | Optional. Equals `Submitter_Phone` when `Submitter_Is_Advertiser` is true. |
| `Team` | Enum | Affiliation: one of the 18 GPSA teams (by name), or `GPSA` for a league-level ad. Drives the 50/50 split and the allowed payment method. |
| `Ad_Title` | Text | Required. Short label for the ad (e.g. "Joe's Pizza — Summer Special"); helps the meet director track it. |
| `Placement` | Enum | `FULL_SCREEN` (18×8″, 9:4) \| `HALF_SCREEN` (9×8″, 9:8). Drives the dimension check. |
| `Status` | Enum | `AWAITING_UPLOAD` → `UPLOADED` → `VALIDATING` → `APPROVED` \| `REJECTED` \| `NEEDS_REVIEW`. |
| `Artwork_URI` | Text | `s3://gpsa-ads/{ad_uuid}/approved_{filename}` once approved. |
| `Artwork_Filename` | Text | Sanitized original filename. |
| `Content_Type` | Text | `image/png` \| `image/jpeg`. |
| `Artwork_Bytes` | Integer | Actual object size from storage. |
| `Artwork_Width` | Integer | Populated by validation. |
| `Artwork_Height` | Integer | Populated by validation. |
| `Validation_Notes` | Text | Why rejected/flagged (e.g. `"3200×1200 not 9:4"` or the Gemini reason). |
| `Rights_Confirmed` | Checkbox | Required `true` to submit. Submitter attests they hold rights to the artwork and grant GPSA permission to display it on the scoreboard. |
| `Rights_Confirmed_At` | DateTime | Set by the API when a submission with the box checked is accepted. Immutable. |
| `Payment_Method` | Enum | `PAY_TEAM` (advertiser pays the affiliated team directly; team remits GPSA's 50%) \| `CHECK` (pay GPSA by check) \| `SQUARE_INVOICE` (GPSA sends a Square invoice). Constrained by `Team` — see below. |
| `Payment_Amount` | Integer (cents) | Set by the API from `Placement` at submission (config map, editable per season). |
| `Payment_Status` | Enum | `PENDING` \| `PAID` \| `WAIVED`. Set manually by admin. |
| `Created_At` | DateTime | Auto. |
| `Updated_At` | DateTime | Auto. |

**Payment rules:**
- If `Team` is one of the 18 teams → `Payment_Method = PAY_TEAM` is the **only** option (the
  advertiser pays that team, which remits GPSA's half).
- If `Team = GPSA` → `Payment_Method ∈ {CHECK, SQUARE_INVOICE}` (paid to GPSA directly).
- **Pricing (2026 rates, raised from $75/$40):** `FULL_SCREEN` **$90**, `HALF_SCREEN`
  **$50**, stored as a `placement → cents` config map so it's adjustable per season. Proceeds
  split **50/50 GPSA / team** when a team is the affiliation.
- Square invoicing is a **manual admin action** for MVP (no Square API integration); the method
  just records how the advertiser will be billed.

**Data minimization:** the artwork file is the artifact of record and lives only in object
storage. The database holds queryable metadata + workflow state + a pointer (`Artwork_URI`).

### Object storage — bucket `gpsa-ads` (private)

```
gpsa-ads/                          (private; no public ACL)
  └── {ad_uuid}/
        ├── pending_{filename}     ← immediately after upload, awaiting validation
        └── approved_{filename}    ← after APPROVED (renamed from pending_)
```

- **Presign policy** (generated against the public upload host) enforces bucket + key prefix +
  `content-length-range` + `Content-Type`:
  ```json
  {
    "expiration": "<15 min>",
    "conditions": [
      ["eq", "$bucket", "gpsa-ads"],
      ["starts-with", "$key", "gpsa-ads/{ad_uuid}/pending_"],
      ["content-length-range", 1, 52428800],
      ["in", "$Content-Type", ["image/png", "image/jpeg"]]
    ]
  }
  ```
  (50 MB cap — a 5400×2400 PNG is well under this. Photos only; no `video/*`.)
- **ObjectCreated webhook** → `POST /internal/uploaded`, secured with `MINIO_TO_API_SECRET`. The
  API ignores events whose key lacks `pending_`, so the rename does not re-trigger validation.
- **Lifecycle rule:** auto-delete `pending_` objects never approved after 30 days.

### Status state machine

```
AWAITING_UPLOAD ─upload→ UPLOADED ─API→ VALIDATING ─dims ok→ [Gemini] ─→ APPROVED
                                            │  dims fail                 ├→ NEEDS_REVIEW ─admin→ APPROVED | REJECTED
                                            └────────────→ REJECTED   (resubmit = new Ad_ID)
```

---

## 5. Artwork spec & validation

Two PowerPoint templates, one per placement. Photo only (PNG/JPG), no video. Since it's a raster
export, pixel count depends on export DPI:

| Placement | Template | Aspect | 150-DPI target (recommended) | 96 DPI | 300 DPI |
|---|---|---|---|---|---|
| `FULL_SCREEN` | 18 × 8″ | **9:4** (2.25:1) | **2700 × 1200** | 1728 × 768 | 5400 × 2400 |
| `HALF_SCREEN` | 9 × 8″ | **9:8** (1.125:1) | **1350 × 1200** | 864 × 768 | 2700 × 2400 |

**Template instruction to submitters:** "Export your slide as **PNG** — full-screen at
**2700×1200**, half-screen at **1350×1200** (both 150 DPI)." Validating against a mandated export
removes ambiguity. (Validation targets are **locked to these 150-DPI sizes**; the aspect ratios
9:4 / 9:8 are fixed regardless. Anything at or above the target with the right aspect passes.)

**Validation logic (Ads API, `sharp`) — config-driven, keyed by `placement`, editable without code:**
- Reject if `Content_Type` not in `{image/png, image/jpeg}`.
- Reject if the aspect ratio deviates > ±1% from the placement's aspect (9:4 full, 9:8 half).
- Reject if `width < target_width` OR `height < target_height` for the placement (avoids
  soft/upscaled art on a large screen).
- Otherwise proceed to the Gemini appropriateness check.

**Gemini appropriateness check (advisory).** The pass flags exactly two things — **offensive/adult
content** and **not-actually-an-advertisement**. (Deliberately *not* flagging political, alcohol,
tobacco, gambling, etc. — those are out of scope for this check.)
- The Ads API sends the image + a prompt to a **Gemini Flash** model
  (`generativelanguage.googleapis.com`): *"You are screening an image submitted as a paid
  advertisement to display on a scoreboard at a family youth swim meet. Flag it if EITHER: (a) it
  contains offensive or adult content — profanity, nudity, sexual content, graphic violence, hate,
  or anything not family-friendly; OR (b) it is clearly not an advertisement — e.g. blank, a
  personal photo, a screenshot, or unrelated content. Do not consider anything else. Respond JSON
  {appropriate: boolean, reason: string}."*
- `appropriate:true` → `APPROVED`. Otherwise → `NEEDS_REVIEW` with the reason in
  `Validation_Notes`. **Never an auto-reject.** On Gemini error/timeout → `NEEDS_REVIEW` (fail
  safe, not fail open).

**Model & cost:** use the current **Gemini Flash** tier (cheapest vision-capable model; confirm
the exact model id at build time). At this volume — on the order of dozens of ads per season, one
image each — per-image cost is a fraction of a cent; total seasonal spend is negligible.

---

## 6. One API node vs. a workflow engine

The Ads API covers everything a workflow engine (e.g. n8n) would have done here. At this volume a
second credentialed service earns nothing.

| Task | Where it lives now | Move to a workflow engine only if… |
|---|---|---|
| Turnstile verify / presign | API `POST /api/submit` (synchronous) | never — latency-critical |
| Dimension validation | API `POST /internal/uploaded` (`sharp`) | you want a no-code rules editor |
| Gemini appropriateness | API async call | you prefer visual branching |
| Confirmation/rejection email | API (`nodemailer` + Eta) | a non-dev must edit copy without a deploy |

**The single async seam** — `ObjectCreated → POST /internal/uploaded` — is the only thing that
would ever be re-pointed at a workflow webhook. Adding one later is a routing change, not a
rearchitecture. **Default: single API node, no workflow engine.**

---

## 7. Infrastructure & deployment

**Recommended shape: one VM per tier (DMZ / Application / Data), each running Docker** — one
Compose stack per VM, containers listed below. VM sizing, host OS, and hardware are the
implementer's call; the design fixes only *which service lives in which tier*. The app runs on
dedicated instances (its own object storage, database, and credentials), not co-tenanted with
unrelated systems.

| VM (tier) | Containers |
|---|---|
| DMZ | web (nginx: form + `/api/*` proxy) · minio-proxy (upload-only) · MinIO |
| Application | Ads API |
| Data | NocoDB |

**Container images.** Three custom images are built in CI (GitHub Actions) and published as **public** packages on
**GHCR**, so the whole deploy is "pull tagged images and `compose up`" with nothing to sync onto
a VM and no registry login:

| Image | Base | Bakes in |
|---|---|---|
| `ghcr.io/gpsaswimming/app-ads-api` | node:alpine | the Fastify Ads API |
| `ghcr.io/gpsaswimming/app-ads-web` | nginx:alpine | the static form (`./public`) + `nginx.conf` |
| `ghcr.io/gpsaswimming/app-ads-proxy` | nginx:alpine | `minio-proxy.conf` (upload-only fence) |

Baking the front-end and proxy (rather than bind-mounting config onto stock nginx) keeps every
deployable artifact immutable and versioned/rollback-able. Only **MinIO** and **NocoDB** run as
official images (their data lives in volumes, not the image).

### Node-to-node traffic model

Who initiates each connection and why. This is the intended traffic map — the operator sets the
actual firewall policy; the design does not prescribe rules.

| From | To | Purpose |
|---|---|---|
| Browser (via edge) | DMZ nginx | Load form; `POST /api/submit` |
| Browser (via edge) | DMZ minio-proxy | `POST /gpsa-ads` upload |
| DMZ nginx | App Ads API | Reverse-proxy `/api/*` |
| DMZ minio-proxy | DMZ MinIO | Forward the upload |
| App Ads API | DMZ MinIO | Presign target host + `pending_`→`approved_` rename (SDK) |
| DMZ MinIO | App Ads API | `ObjectCreated` webhook → `/internal/uploaded` |
| App Ads API | Data NocoDB | Metadata reads/writes (REST) |
| App Ads API | Internet | Gemini API, SMTP relay |
| Meet director (LAN) | DMZ MinIO :9000 / :9001 | Download approved artwork + console (LAN only) |
| Admin (VPN) | Data NocoDB UI | Review, set payment status |

Internal traffic between tiers is plain HTTP; TLS terminates at the edge. No public path reaches
the Ads API, NocoDB, or MinIO's own ports.

```yaml
# sketch — one Compose stack per VM (tier)
# DMZ tier VM
services:
  web:                                   # serves form + reverse-proxies /api/*
    image: ghcr.io/gpsaswimming/app-ads-web:latest    # nginx + baked ./public + nginx.conf
    env_file: ./web.env
    environment:                          # entrypoint injects these into the static form at start
      TURNSTILE_SITE_KEY: ${TURNSTILE_SITE_KEY}       # public site key (not a secret)
      UPLOAD_URL: ${UPLOAD_URL}                       # https://ads-upload.gpsaswimming.org/gpsa-ads

  minio-proxy:                           # upload-only fence in front of object storage
    image: ghcr.io/gpsaswimming/app-ads-proxy:latest  # nginx + baked minio-proxy.conf
    env_file: ./proxy.env
    environment:                          # entrypoint envsubst's these into the nginx conf at start
      ALLOW_ORIGIN: ${ALLOW_ORIGIN}                   # https://ads.gpsaswimming.org
    # forwards POST /gpsa-ads → minio:9000

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_SERVER_URL: http://minio.lan:9000   # LAN API address — NOT the public host (that breaks the console)
      MINIO_NOTIFY_WEBHOOK_ENABLE_ADS: "on"
      MINIO_NOTIFY_WEBHOOK_ENDPOINT_ADS: "http://ads-api.gpsa.local:8080/internal/uploaded"
      MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_ADS: ${MINIO_TO_API_SECRET}
    volumes: [ "minio_data:/data" ]
    ports:
      - "9000:9000"   # S3 — internal (Ads API) + LAN (downloads); public only via minio-proxy
      - "9001:9001"   # console — LAN only; NEVER added to edge routing

# Application tier VM — makes the outbound calls (Gemini, SMTP)
  ads-api:
    image: ghcr.io/gpsaswimming/app-ads-api:latest   # built + pushed by CI; `build:` for local dev
    environment:
      MINIO_ENDPOINT_INTERNAL: http://minio.gpsa.local:9000        # SDK: renames
      MINIO_ENDPOINT_PUBLIC:  https://ads-upload.gpsaswimming.org  # presign target host
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      NOCODB_URL: http://nocodb.gpsa.local:8080
      NOCODB_TOKEN: ${NOCODB_TOKEN}
      TURNSTILE_SECRET: ${TURNSTILE_SECRET}
      MINIO_TO_API_SECRET: ${MINIO_TO_API_SECRET}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      SMTP_URL: ${SMTP_URL}
      ADS_NOTIFY_EMAIL: ${ADS_NOTIFY_EMAIL}     # internal "new submission" notifications
      SUBMISSION_DEADLINE: ${SUBMISSION_DEADLINE} # ISO date; form closes + API rejects after

# Data tier VM — no outbound internet calls by design
  nocodb:
    image: nocodb/nocodb:latest
    volumes: [ "nocodb_data:/usr/app/data" ]   # never publicly routed — VPN only

volumes: { minio_data: , nocodb_data: }
```

Sketch of the upload-only proxy config (nginx):
```nginx
# minio-proxy.conf
server {
  listen 80;
  server_name ads-upload.gpsaswimming.org;

  # CORS preflight for the form origin
  location = /gpsa-ads {
    if ($request_method = OPTIONS) {
      add_header Access-Control-Allow-Origin  "https://ads.gpsaswimming.org" always;
      add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
      add_header Access-Control-Allow-Headers "Content-Type" always;
      add_header Content-Length 0; return 204;
    }
    if ($request_method != POST) { return 405; }   # upload only
    add_header Access-Control-Allow-Origin "https://ads.gpsaswimming.org" always;
    proxy_set_header Host $host;                    # preserve host → signature validates
    client_max_body_size 50m;
    proxy_pass http://minio:9000;
  }
  location / { return 403; }                        # nothing else is reachable
}
```

**Domains / routing (edge reverse proxy):**

| Host / path | → | Exposure |
|---|---|---|
| `ads.gpsaswimming.org/` | nginx (DMZ) | Public |
| `ads.gpsaswimming.org/api/*` | nginx → Ads API (App) | Public, path-scoped; **same-origin, no CORS** |
| `ads-upload.gpsaswimming.org` | minio-proxy → MinIO (DMZ) | Public, **`POST /gpsa-ads` only** |
| MinIO :9000/:9001, NocoDB UI, `/internal/*` | — | Internal / **LAN / VPN only**, never public |

Firewall policy between tiers is the operator's responsibility — see the node-to-node traffic
model above for the intended connections. Outbound traffic is not policed at the app level.

**Optional bulk-export helper (meet prep).** So the meet director isn't clicking through the
console one object at a time, a tiny LAN-side script pulls every approved ad for a meet into a
local folder to curate. No service, no schedule — just `mc` on the operator's machine:
```bash
# grab all approved artwork into ./ads-YYYY-citymeet/
mc alias set gpsa http://minio.lan:9000 "$KEY" "$SECRET"
mc find gpsa/gpsa-ads --name 'approved_*' --exec 'mc cp {} ./ads-2026-citymeet/'
```
(Filtering to a specific meet can key off `Ad_ID` folders once the meet's IDs are exported from
NocoDB, or simply grab everything currently in the bucket for a single-meet season.)

### Configuration & secrets

**Guiding principle: images are secret-free and environment-agnostic.** Nothing sensitive or
environment-specific is baked into an image or passed to CI. Every value is a variable, injected
at **runtime** on the VM via a per-service `.env` (git-ignored, `chmod 600`; a committed
`.env.example` documents the keys). `web` and `minio-proxy` are stock nginx images whose
entrypoints `envsubst` their variables into the static form / nginx config at container start —
so the same image runs in any environment. `S` = secret (harm if leaked), `C` = config
(environment-specific but not sensitive).

**DMZ VM** — `minio.env`, `web.env`, `proxy.env`:

| Variable | S/C | Service | Purpose |
|---|---|---|---|
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | S | minio | Admin bootstrap (not used by the app) |
| `MINIO_TO_API_SECRET` | S | minio | Auth header on the ObjectCreated webhook (**shared** — see below) |
| `MINIO_SERVER_URL` | C | minio | MinIO's LAN API address (NOT the public host — presigned POST is host-independent; the public host breaks the console) |
| `MINIO_NOTIFY_WEBHOOK_ENDPOINT_ADS` | C | minio | The API's `/internal/uploaded` URL |
| `TURNSTILE_SITE_KEY` | C | web | Public Turnstile key, injected into the form |
| `UPLOAD_URL` | C | web | Upload host the browser POSTs to |
| `ALLOW_ORIGIN` | C | minio-proxy | CORS origin (the form's URL) |

**Application VM** — `ads-api.env`:

| Variable | S/C | Purpose |
|---|---|---|
| `MINIO_ENDPOINT_INTERNAL` / `MINIO_ENDPOINT_PUBLIC` | C | Internal SDK host / public presign-target host |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | S | Scoped MinIO **service account** (not root) |
| `MINIO_TO_API_SECRET` | S | Verifies the webhook (**shared** with `minio.env`) |
| `NOCODB_URL` | C | Database base URL |
| `NOCODB_TOKEN` | S | Database API token |
| `NOCODB_BASE_ID` / `NOCODB_ADS_TABLE_ID` | C | Provisioned base/table IDs (from setup) |
| `TURNSTILE_SECRET` | S | Turnstile server-side `siteverify` |
| `GEMINI_API_KEY` | S | Appropriateness check |
| `SMTP_URL` | S | Email transport (contains credentials) |
| `ADS_NOTIFY_EMAIL` | C | Internal "new submission" recipient |
| `GPSA_CHECK_ADDRESS` | C | Mailing address inserted into the CHECK email |
| `SUBMISSION_DEADLINE` | C | Form-close / late-reject date |
| `PRICE_FULL_CENTS` / `PRICE_HALF_CENTS` | C | Per-placement price map (9000 / 5000) |

**Data VM** — `nocodb.env`:

| Variable | S/C | Purpose |
|---|---|---|
| `NC_AUTH_JWT_SECRET` | S | NocoDB session signing |
| `NC_DB` | S | External DB connection string (omit if using the bundled SQLite volume) |
| `NC_PUBLIC_URL` | C | Base URL (optional) |

**Shared secret:** `MINIO_TO_API_SECRET` must be **identical** in `minio.env` and `ads-api.env`.
The MinIO **service-account** keys (`MINIO_ACCESS_KEY/SECRET_KEY`) are created inside MinIO after
setup (`mc admin user svcacct add`, scoped to `gpsa-ads`) and then placed in `ads-api.env` — root
credentials are never used by the app.

### GitHub repo — secrets vs. variables

Because images are secret-free and deployment is pull-based, **CI needs no manually-set repo
secrets**:

| Item | Where | Notes |
|---|---|---|
| GHCR **push** (CI build) | built-in `GITHUB_TOKEN` | Automatic with `packages: write`; no secret to create. |
| Image name / org | repo **variable** (optional) | e.g. `IMAGE_PREFIX=ghcr.io/gpsaswimming/app-ads`; or just hard-code. |
| GHCR **pull** (on each VM) | none | Packages are **public** — VMs pull with no auth, no `docker login`. |
| Remote deploy (future) | repo **secrets** — only then | If CI ever SSHes to deploy, `SSH_KEY`/`SSH_HOST` would be repo secrets. Not needed for the pull-based model. |

**Bottom line:** app secrets live *only* in the per-VM `.env` files. The GitHub repo holds no app
secrets at all (build+push rides the automatic `GITHUB_TOKEN`), and — with public images — the
VMs need no registry credential either. Every secret is on the VMs; nowhere else.

---

## 8. Frontend (this repo)

Self-hosted nginx static site in the DMZ. Follows the GPSA tool conventions:
- Shared CSS `https://css.gpsaswimming.org/gpsa-tools-common.css`; brand from `assets.gpsaswimming.org`.
- Navy `#002366` / Red `#d9242b`; font Inter. `max-w-7xl mx-auto`, `showToast()`, `escapeHtml()`.
- Calls the API **same-origin** at `/api/*` — no CORS. Uploads go cross-origin to
  `ads-upload.gpsaswimming.org` — CORS handled by minio-proxy.

**Intro copy (top of form):** "Ads will scroll on the large scoreboard at the Hampton Virginia
Aquaplex throughout the day (not during swim events). Proceeds from ad sales are divided 50/50
between GPSA and your team. **Full-screen $90 · Half-screen $50.**"

**Form fields, in order:**
- **Submitter** — name, email, phone (optional).
- **Advertiser** — Company name, Affiliation (dropdown: 18 GPSA teams + **GPSA** for a
  league-level ad), Ad title. A checkbox **"I am the advertiser"** — when checked, hides and
  auto-fills the advertiser contact from the submitter; when unchecked, shows required advertiser
  contact (name, email, phone?).
- **Ad** — Placement (full-screen $90 / half-screen $50, each with a small diagram + the required
  export size), file picker (`accept="image/png,image/jpeg"`), and a link to download the matching
  PowerPoint template.
- **Payment** — driven by the affiliation: if a **team** is selected, show read-only "Pay your
  team directly ($AMOUNT)"; if **GPSA** is selected, choose **Check** or **Square Invoice**.
- **Rights** — required checkbox: "I have the right to use this artwork and grant GPSA permission
  to display it on the scoreboard."
- **Turnstile** widget, then submit.

After submit: upload progress → success state with the `Ad_ID`, the amount due + how to pay, and
a "confirmation email coming" note.

**After the deadline** (`SUBMISSION_DEADLINE`), the form renders a "submissions are closed for
this season" state instead of the form (with the API rejecting late POSTs as a backstop).

---

## 9. Emails, notifications & submission window

### Submission window
A config value **`SUBMISSION_DEADLINE`** (date) gates the form, set once per season:
- **Before the deadline:** the form is open as normal.
- **After the deadline:** the static form renders a "submissions are closed" state, and the API
  rejects any `POST /api/submit` with `403 SUBMISSIONS_CLOSED` (checked first — belt-and-
  suspenders so a cached page can't submit late).

### Submitter emails (sent by the Ads API via SMTP)
Validation runs within seconds of upload, so one outcome email per submission serves as both
receipt and status:

| Trigger | Email to submitter |
|---|---|
| **APPROVED** | "Received & approved — *[Ad_Title]*, *[Placement]*. **Amount due $X.** *[payment instructions by method]*." |
| **REJECTED** (bad dimensions) | "We couldn't accept it — *[reason]*. Re-export at the required size and resubmit." |
| **NEEDS_REVIEW** | "Received — it's under review and we'll follow up shortly." |

**Payment instructions by method** (inserted into the APPROVED email):
- `PAY_TEAM` → "Please pay your team (*[Team]*) directly — **$X**."
- `CHECK` → "Mail a **$X** check to GPSA at *[mailing address — supply at deploy]*."
- `SQUARE_INVOICE` → "GPSA will email you a Square invoice for **$X**."

### Internal notification
On **every** submission, the API emails a GPSA address (**`ADS_NOTIFY_EMAIL`**, supplied at
deploy) a one-line summary — submitter, company, team, placement, amount, payment method, status
(approved / rejected / needs-review), and the `Ad_ID` — so the ad chair tracks sales in real time
and sees `NEEDS_REVIEW` items immediately.

**Config added:** `SUBMISSION_DEADLINE`, `ADS_NOTIFY_EMAIL` (plus the check mailing address baked
into the email template). SMTP config is already listed in §7.

---

## 10. Open items to finalize (before build)

1. ~~Half-screen dimensions~~ — **RESOLVED (2026-07-23):** two placements, `FULL_SCREEN` 18×8″
   (9:4) and `HALF_SCREEN` 9×8″ (9:8).
2. ~~Ads API tier placement~~ — **RESOLVED (2026-07-23):** Option A, application tier (§1b).
3. ~~Scoreboard native pixel resolution~~ — **DECIDED (2026-07-23):** keep the 150-DPI defaults
   (2700×1200 full / 1350×1200 half) as the locked validation targets.
4. ~~Deployment host~~ — **DECIDED (2026-07-23):** one VM per tier, each running Docker; custom
   Ads API image via GHCR. VM sizing/hardware/tier segments left to the implementer (§7).
5. ~~Download logistics~~ — **DECIDED (2026-07-23):** the **meet director** pulls approved ads on
   the LAN and curates them before the meet; an optional `mc` bulk-export helper is provided (§7).
6. ~~Pricing~~ — **DECIDED (2026-07-23):** FULL_SCREEN $90, HALF_SCREEN $50 (raised from the prior $75/$40 rates,
   as this season's default; config map, editable per season). Payment method by affiliation:
   team ⇒ pay the team; GPSA ⇒ check or Square Invoice. 50/50 GPSA/team split.
7. ~~Deadline handling~~ — **DECIDED (2026-07-23):** auto-close on a `SUBMISSION_DEADLINE` config
   date — form shows "closed", API rejects late POSTs (§9).
8. ~~Email content + internal notification~~ — **DECIDED (2026-07-23):** one outcome email per
   submission (approved/rejected/needs-review) + an internal notification to `ADS_NOTIFY_EMAIL`
   on every submission (§9).
9. ~~Gemini model + budget~~ — **DECIDED (2026-07-23):** current Gemini **Flash** tier; flags
   only offensive/adult + not-an-ad; cost negligible at this volume. Confirm exact model id at
   build time.

**Deploy-time values to supply (not design decisions):** `SUBMISSION_DEADLINE` (this season's
date), `ADS_NOTIFY_EMAIL` (ad-chair address), GPSA's **check mailing address** (for the email
template), and the Turnstile/Gemini/SMTP credentials.

---

## 11. Approval & build

**Status: APPROVED — 2026-07-23.** Implementation may proceed.

Build **one component at a time** following the sequenced checklist in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md). Before building each component, read the relevant section
of this document, and **honor the §3 security invariants throughout**. The deploy-time values in
§10 are supplied by the operator at deploy time — they do not block building or testing locally.

Build order (detail + acceptance criteria in `IMPLEMENTATION.md`):
1. Repo scaffold + per-service `.env.example`.
2. **Ads API** (`app-ads-api`) — everything depends on it.
3. Web frontend (`app-ads-web`).
4. Upload proxy (`app-ads-proxy`).
5. Infrastructure & provisioning (compose, MinIO bucket/webhook, NocoDB base/table).
6. CI/CD (build + push the 3 public images to GHCR).
7. Edge routing + end-to-end smoke test.

---

## 12. Future enhancements (deferred)

Out of scope for the 2026 build; captured here so they aren't lost.

- **Meet selection dropdown (2027+).** Today `Meet` is a single fixed value (one City Meet per
  season, set by config). When the platform serves more than one meet/event, promote `Meet` to a
  **user-facing dropdown** on the form, backed by a config list of currently-open meets, so each
  submission is bound to a chosen meet. The `Meet` field already exists in the schema and the
  bucket key layout is meet-agnostic, so this is **additive** — a form control + a config list of
  open meets (each optionally with its own `SUBMISSION_DEADLINE`) + scoping the admin views by
  meet. No data migration required.
