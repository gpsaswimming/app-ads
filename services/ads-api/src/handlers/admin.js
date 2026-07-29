// /admin-api/* — the internal admin dashboard's backend (docs/TODO.md #1).
//
// These endpoints are reached ONLY from the app-ads-admin container on the VPN/LAN
// (never routed to the public edge — the public DMZ nginx 404s /admin-api/). There is
// no app-level auth by design: the VPN boundary is the trust boundary. The Ads API stays
// the sole credential holder (DESIGN.md §3 inv 4) — the dashboard holds zero creds and
// goes through here for everything (NocoDB reads, artwork bytes, the approve rename).

import { amountCents, gpsaDueCents, isTeamAffiliated } from '../billing.js';
import { STATUS } from '../constants.js';
import { keyFromUri } from '../clients/minio.js';

// Statuses the treasurer report accounts for. APPROVED ads are billable; NEEDS_REVIEW ads
// are carried alongside as "could still land" so a report read mid-season isn't misleading.
// Rejected and in-flight ads (AWAITING_UPLOAD / VALIDATING) are money that does not exist.
const BILLABLE = STATUS.APPROVED;
const PENDING = STATUS.NEEDS_REVIEW;

/** Project a NocoDB row to the fields the dashboard shows. VPN-only, but stay tidy. */
function toSummary(row, bucket) {
  return {
    ad_id: row.Ad_ID,
    created_at: row.CreatedAt ?? null,
    status: row.Status,
    company_name: row.Company_Name,
    team: row.Team,
    ad_title: row.Ad_Title,
    placement: row.Placement,
    submitter_is_advertiser: Boolean(row.Submitter_Is_Advertiser),
    submitter_name: row.Submitter_Name,
    submitter_email: row.Submitter_Email,
    submitter_phone: row.Submitter_Phone || '',
    advertiser_name: row.Advertiser_Name,
    advertiser_email: row.Advertiser_Email,
    advertiser_phone: row.Advertiser_Phone || '',
    content_type: row.Content_Type || null,
    artwork_filename: row.Artwork_Filename || null,
    artwork_width: row.Artwork_Width ?? null,
    artwork_height: row.Artwork_Height ?? null,
    artwork_bytes: row.Artwork_Bytes ?? null,
    validation_notes: row.Validation_Notes || '',
    payment_method: row.Payment_Method,
    payment_amount: row.Payment_Amount ?? null,
    payment_status: row.Payment_Status,
    has_artwork: Boolean(keyFromUri(row.Artwork_URI, bucket)),
  };
}

/** One line of a team's page on the treasurer report. */
function toLine(row) {
  return {
    ad_id: row.Ad_ID,
    submitted_at: row.CreatedAt ?? null,
    status: row.Status,
    company_name: row.Company_Name || '',
    ad_title: row.Ad_Title || '',
    placement: row.Placement || null,
    payment_method: row.Payment_Method || null,
    payment_status: row.Payment_Status || null,
    // What the advertiser owes for the ad …
    amount_cents: amountCents(row),
    // … and the slice of it the team remits to GPSA (0 until the ad is approved).
    gpsa_due_cents: gpsaDueCents(row),
  };
}

/** A fresh per-affiliation accumulator. `team` is a team name or `GPSA`. */
function newGroup(team) {
  return {
    team,
    is_gpsa: team === 'GPSA',
    full_count: 0,
    half_count: 0,
    ad_count: 0,
    // Approved ads only — what the advertisers owe in total for this affiliation.
    gross_cents: 0,
    // Team → GPSA remittance (50% of approved). Always 0 for the GPSA group.
    gpsa_due_cents: 0,
    // The half the team keeps. Always 0 for the GPSA group.
    team_keeps_cents: 0,
    // Approved ads the advertiser has not settled yet (Payment_Status other than
    // PAID/WAIVED) — the treasurer's chase list. Does not reduce gpsa_due_cents.
    unpaid_count: 0,
    unpaid_cents: 0,
    // Still under review: not counted anywhere above, shown so the report reads honestly
    // mid-season ("three more could still land").
    pending_count: 0,
    pending_cents: 0,
    ads: [],
  };
}

function addToGroup(group, row) {
  const line = toLine(row);
  group.ads.push(line);

  if (row.Status === PENDING) {
    group.pending_count += 1;
    group.pending_cents += line.amount_cents || 0;
    return;
  }

  group.ad_count += 1;
  if (row.Placement === 'FULL_SCREEN') group.full_count += 1;
  else if (row.Placement === 'HALF_SCREEN') group.half_count += 1;
  group.gross_cents += line.amount_cents || 0;
  group.gpsa_due_cents += line.gpsa_due_cents;
  if (isTeamAffiliated(row)) group.team_keeps_cents += (line.amount_cents || 0) - line.gpsa_due_cents;
  if (row.Payment_Status !== 'PAID' && row.Payment_Status !== 'WAIVED') {
    group.unpaid_count += 1;
    group.unpaid_cents += line.amount_cents || 0;
  }
}

export function makeAdminHandlers(ctx) {
  const { log, noco, minio, mailer } = ctx;
  const bucket = minio.bucket;

  /** GET /admin-api/ads — all submissions (browser filters/sorts; volume is tiny). */
  async function list(request, reply) {
    const rows = await noco.listAds({ limit: 1000 });
    return reply.send({ ads: rows.map((r) => toSummary(r, bucket)) });
  }

  /** GET /admin-api/ads/:adId/artwork — stream the current object bytes for preview. */
  async function artwork(request, reply) {
    const row = await noco.findByAdId(request.params.adId);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });

    const key = keyFromUri(row.Artwork_URI, minio.bucket);
    if (!key) return reply.code(404).send({ error: 'NO_ARTWORK' });

    const buffer = await minio.getObjectBuffer(key);
    return reply
      .header('Cache-Control', 'private, no-store')
      .type(row.Content_Type || 'application/octet-stream')
      .send(buffer);
  }

  /**
   * POST /admin-api/ads/:adId/approve — mark APPROVED. Mirrors the automatic Gemini-pass
   * path: if the object is still `pending_`, rename it to `approved_` so the meet-director
   * export (which globs approved_*) picks up manually-approved artwork (docs/TODO.md #1).
   */
  async function approve(request, reply) {
    const row = await noco.findByAdId(request.params.adId);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });

    if (row.Status === STATUS.APPROVED) {
      return reply.send({ ad: toSummary(row, bucket) }); // idempotent no-op
    }

    const key = keyFromUri(row.Artwork_URI, minio.bucket);
    if (!key) return reply.code(409).send({ error: 'NO_ARTWORK' }); // nothing uploaded yet

    let uri = row.Artwork_URI;
    if (key.includes('pending_')) {
      const newKey = await minio.renameToApproved(key);
      uri = `s3://${minio.bucket}/${newKey}`;
    }

    const update = { Status: STATUS.APPROVED, Artwork_URI: uri };
    await noco.updateAd(row.Id, update);
    Object.assign(row, update);

    // Close the loop with the submitter (they last heard "under review"). Non-fatal:
    // an SMTP hiccup must not fail the approval — the status change is what matters.
    try {
      await mailer.sendOutcome(row);
    } catch (err) {
      log.warn({ adId: row.Ad_ID, err: err.message }, 'approve: outcome email failed');
    }

    log.info({ adId: row.Ad_ID }, 'ad approved by admin');
    return reply.send({ ad: toSummary(row, bucket) });
  }

  /** POST /admin-api/ads/:adId/deny — mark REJECTED with an optional reason. */
  async function deny(request, reply) {
    const row = await noco.findByAdId(request.params.adId);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });

    const reason = String(request.body?.reason || '').trim();
    const update = {
      Status: STATUS.REJECTED,
      Validation_Notes: reason || row.Validation_Notes || 'Not approved for display',
    };
    await noco.updateAd(row.Id, update);
    Object.assign(row, update);

    try {
      await mailer.sendOutcome(row);
    } catch (err) {
      log.warn({ adId: row.Ad_ID, err: err.message }, 'deny: outcome email failed');
    }

    log.info({ adId: row.Ad_ID }, 'ad denied by admin');
    return reply.send({ ad: toSummary(row, bucket) });
  }

  /**
   * GET /admin-api/treasurer — what each team owes GPSA (docs/TODO.md #1).
   *
   * One payload serves both screens: a per-affiliation summary (full/half counts + the
   * highlighted amount due) and, in `ads`, the per-team detail page. Volume is dozens of
   * rows per season, so a second round-trip per team would buy nothing. The split rule
   * lives in billing.js — the browser never recomputes money.
   */
  async function treasurer(request, reply) {
    const rows = await noco.listAds({ limit: 1000 });

    const groups = new Map();
    for (const row of rows) {
      if (row.Status !== BILLABLE && row.Status !== PENDING) continue;
      const key = row.Team || 'Unassigned';
      if (!groups.has(key)) groups.set(key, newGroup(key));
      addToGroup(groups.get(key), row);
    }

    // Teams alphabetically; the GPSA (league) group last — it's a different kind of line
    // (collected directly, nobody owes it), so it reads as a footnote to the team list.
    const teams = [...groups.values()].sort((a, b) => (
      a.is_gpsa - b.is_gpsa || a.team.localeCompare(b.team)
    ));
    for (const g of teams) {
      g.ads.sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
    }

    const totals = teams.reduce((t, g) => ({
      team_count: t.team_count + (g.is_gpsa ? 0 : 1),
      full_count: t.full_count + g.full_count,
      half_count: t.half_count + g.half_count,
      ad_count: t.ad_count + g.ad_count,
      gross_cents: t.gross_cents + g.gross_cents,
      // The bottom line: what GPSA is owed by the teams.
      gpsa_due_cents: t.gpsa_due_cents + g.gpsa_due_cents,
      // League-affiliation ads, billed to the advertiser by GPSA itself.
      gpsa_direct_cents: t.gpsa_direct_cents + (g.is_gpsa ? g.gross_cents : 0),
      unpaid_count: t.unpaid_count + g.unpaid_count,
      unpaid_cents: t.unpaid_cents + g.unpaid_cents,
      pending_count: t.pending_count + g.pending_count,
      pending_cents: t.pending_cents + g.pending_cents,
    }), {
      team_count: 0, full_count: 0, half_count: 0, ad_count: 0, gross_cents: 0,
      gpsa_due_cents: 0, gpsa_direct_cents: 0, unpaid_count: 0, unpaid_cents: 0,
      pending_count: 0, pending_cents: 0,
    });

    return reply.send({
      meet: ctx.config?.meetName || null,
      generated_at: new Date().toISOString(),
      teams,
      totals,
    });
  }

  return { list, artwork, approve, deny, treasurer };
}
