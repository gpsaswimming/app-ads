# Backlog — app-ads

Post-launch enhancements. The core intake platform (form → validate → store → review) is
live; these build on it. Not yet scheduled — capture + refine here first.

---

## 1. Admin dashboard (internal / VPN-only) — **in progress**

A purpose-built admin UI so the ad chair and treasurer don't work out of raw NocoDB.
**Internal access only** (LAN/VPN, like NocoDB — never public).

**Architecture (decided 2026-07-23):** option (c) — a thin **`app-ads-admin`** nginx
container (static SPA + reverse-proxy `/admin-api/*` to the Ads API, **zero credentials**)
plus new **`/admin-api/*` endpoints on the existing Ads API**. This keeps the Ads API the
**sole credential holder** (DESIGN.md §3 inv 4): a standalone service reading NocoDB/MinIO
itself (option a) would be a second credential holder, and the approve-rename below must
go through the API regardless. **Auth (decided):** none at the app layer — the **VPN
boundary is the trust boundary** (the public DMZ nginx 404s `/admin-api/`; the container is
never edge-routed). Layer a shared token on later if the trust model tightens.

- [x] **Review** — list submissions with the artwork preview + key fields (submitter,
      company, team, placement, amount, status, validation notes). *(SPA table + detail
      drawer; artwork streamed via `GET /admin-api/ads/:id/artwork` since there is no
      public read path to MinIO.)*
- [x] **Approve / deny** — set `Status` from the dashboard.
      - ✅ **Done:** `POST /admin-api/ads/:id/approve` renames `pending_ → approved_` (like
        the Gemini-pass path) then sets `APPROVED`, so manually-approved artwork is picked
        up by the meet-director export (which globs `approved_*`); `deny` sets `REJECTED`
        with a reason. Both email the submitter the final outcome (non-fatal on SMTP error).
- [ ] **Bulk export** — download all approved artwork for the meet (today: the
      `export-approved.sh` CLI). Dashboard button that zips/grabs `approved_*`.
- [ ] **Treasurer report — how much each team owes.** Aggregate `Payment_Amount` by team
      and payment status. Rules to encode:
      - `PAY_TEAM` ads → the advertiser pays the **team**; the team remits **GPSA's 50%**.
        Report shows, per team: total ad revenue and the 50% owed to GPSA.
      - `GPSA` ads (`CHECK` / `SQUARE_INVOICE`) → paid to GPSA directly (not a team debt).
      - Filterable by `Payment_Status` (PENDING / PAID / WAIVED) so the treasurer can chase
        outstanding balances.
      - ⚠️ Needs a **set-payment-status** admin endpoint (`PENDING`/`PAID`/`WAIVED`) — not
        yet built; add it with this report.

---

<!-- Add #2, #3, … below as they come. -->
