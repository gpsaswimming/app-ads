// /admin-api/* — the internal admin dashboard's backend (docs/TODO.md #1).
//
// These endpoints are reached ONLY from the app-ads-admin container on the VPN/LAN
// (never routed to the public edge — the public DMZ nginx 404s /admin-api/). There is
// no app-level auth by design: the VPN boundary is the trust boundary. The Ads API stays
// the sole credential holder (DESIGN.md §3 inv 4) — the dashboard holds zero creds and
// goes through here for everything (NocoDB reads, artwork bytes, the approve rename).

import { isTeamAffiliated } from '../billing.js';
import { PAYMENT_STATUSES, STATUS } from '../constants.js';
import { keyFromUri } from '../clients/minio.js';
import { artworkZipFilename, createArtworkZip, planArtworkExport } from '../reports/artwork-export.js';
import { buildTreasurerReport } from '../reports/treasurer.js';
import { renderTreasurerPdf, treasurerPdfFilename } from '../reports/treasurer-pdf.js';

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
   * POST /admin-api/ads/:adId/payment — record whether a league invoice has been settled.
   *
   * Only league (GPSA-affiliation) ads are tracked: those are billed by GPSA itself, by
   * check or Square invoice, so GPSA knows when the money arrives. A team-affiliation ad is
   * collected by the team from its advertiser — GPSA never sees that transaction and does
   * not track it (the team still owes its 50% either way), so this rejects those rather
   * than storing a status nothing maintains.
   */
  async function setPayment(request, reply) {
    const status = String(request.body?.payment_status || '').toUpperCase();
    if (!PAYMENT_STATUSES.includes(status)) {
      return reply.code(400).send({ error: 'BAD_PAYMENT_STATUS', allowed: PAYMENT_STATUSES });
    }

    const row = await noco.findByAdId(request.params.adId);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (isTeamAffiliated(row)) {
      return reply.code(409).send({ error: 'PAY_TEAM_NOT_TRACKED' });
    }

    const update = { Payment_Status: status };
    await noco.updateAd(row.Id, update);
    Object.assign(row, update);

    log.info({ adId: row.Ad_ID, paymentStatus: status }, 'payment status set by admin');
    return reply.send({ ad: toSummary(row, bucket) });
  }

  /**
   * GET /admin-api/treasurer.pdf — the treasurer report, as a PDF download.
   *
   * A print-ready document, not a screen: page 1 is the league summary (a row per team, the
   * amount due highlighted, grand total at the foot), then one page per team listing that
   * team's ads with each amount and the total due. Generated here because this is the tier
   * that can read NocoDB; the dashboard just links to it.
   */
  async function treasurerPdf(request, reply) {
    const rows = await noco.listAds({ limit: 1000 });
    const report = buildTreasurerReport(rows, { meet: ctx.config?.meetName || null });
    const pdf = await renderTreasurerPdf(report);

    log.info({ teams: report.teams.length, dueCents: report.totals.gpsa_due_cents }, 'treasurer report generated');
    return reply
      .header('content-disposition', `attachment; filename="${treasurerPdfFilename(report)}"`)
      .header('cache-control', 'private, no-store')
      .type('application/pdf')
      .send(pdf);
  }

  /**
   * GET /admin-api/export.zip — every approved ad's artwork, for building the scoreboard
   * deck. Same set the `export-approved.sh` LAN helper pulls, one click instead of `mc`:
   * foldered by placement, numbered, named for the advertiser. Streamed an object at a
   * time — the API is the only component that can read the private bucket.
   */
  async function exportZip(request, reply) {
    const rows = await noco.listAds({ limit: 1000 });
    const entries = planArtworkExport(rows, bucket);
    if (entries.length === 0) {
      return reply.code(404).send({ error: 'NO_APPROVED_ARTWORK' });
    }

    log.info({ ads: entries.length }, 'artwork export requested');
    return reply
      .header('content-disposition', `attachment; filename="${artworkZipFilename(ctx.config?.meetName)}"`)
      .header('cache-control', 'private, no-store')
      .type('application/zip')
      .send(createArtworkZip(entries, (key) => minio.getObjectBuffer(key)));
  }

  return { list, artwork, approve, deny, setPayment, treasurerPdf, exportZip };
}
