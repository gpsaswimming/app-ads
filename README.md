# app-ads — GPSA Scoreboard Ads

Submission platform for **digital scoreboard advertisements** shown on the City Meet scoreboard at
the Hampton Virginia Aquaplex during warm-ups and award breaks. Sponsors and teams submit a
high-resolution photo in one of two placements — **full-screen (18×8″)** or **half-screen (9×8″)** —
which is validated, reviewed, and made available to the meet director.

- **Live:** [ads.gpsaswimming.org](https://ads.gpsaswimming.org) *(planned)*
- **Design (source of truth):** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Build plan:** [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)

## How it works

A public form (behind Cloudflare Turnstile) collects the ad details and hands off a **presigned
upload** so the artwork goes straight to object storage. A small **Ads API** verifies the
submission, validates the image dimensions, runs an appropriateness check, and emails the
submitter the outcome. Metadata and payment status live in a database; the meet director pulls the
approved artwork before the meet.

```
browser → web (form) + upload proxy → object storage
                     ↘ Ads API → database, email, image checks
```

Three network tiers (DMZ / Application / Data); the browser only ever touches the DMZ. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture, data model, and security model.

## Tech

Node.js/Fastify (API) · nginx (form + upload proxy) · MinIO (object storage) · NocoDB (metadata) ·
Cloudflare Turnstile · Google Gemini (appropriateness check). Deployed as three container images
published to GHCR.

## Contributing

**Never commit to `main`** — all work goes on a feature branch and lands via a pull request. See
the ground rules and the step-by-step build plan in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).
