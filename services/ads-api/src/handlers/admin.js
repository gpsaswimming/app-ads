// /admin-api/* — the internal admin dashboard's backend (docs/TODO.md #1).
//
// These endpoints are reached ONLY from the app-ads-admin container on the VPN/LAN
// (never routed to the public edge — the public DMZ nginx 404s /admin-api/). There is
// no app-level auth by design: the VPN boundary is the trust boundary. The Ads API stays
// the sole credential holder (DESIGN.md §3 inv 4) — the dashboard holds zero creds and
// goes through here for everything (NocoDB reads, artwork bytes, the approve rename).

import { STATUS } from '../constants.js';
import { keyFromUri } from '../clients/minio.js';

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

  return { list, artwork, approve, deny };
}
