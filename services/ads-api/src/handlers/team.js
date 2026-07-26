// /api/team/* — the team-facing ad status list (DESIGN.md §12). Read-only, no app-level
// auth and no per-team scoping — like the admin tool, you land on the page and get the
// list. Exposure is a deployment choice (edge/network), not app logic.
//
// Artwork: teams can view the actual ad. The image bytes are STREAMED THROUGH THE API
// (which holds the storage creds) exactly like the admin dashboard — the bucket stays
// private (no public GET), the picture just reaches the gated viewer through this origin.

import { STATUS } from '../constants.js';
import { keyFromUri } from '../clients/minio.js';

// Statuses shown. Transient in-flight states (AWAITING_UPLOAD / UPLOADED / VALIDATING) are
// hidden — they resolve within seconds and would only confuse. REJECTED is hidden unless
// the viewer opts in via ?include_rejected=true.
const DEFAULT_VISIBLE = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW]);
const WITH_REJECTED = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW, STATUS.REJECTED]);

/** Project a NocoDB Ads row to the minimal, safe shape the status list renders. */
function toTeamAd(row, bucket) {
  const isRejected = row.Status === STATUS.REJECTED;
  const isApproved = row.Status === STATUS.APPROVED;
  const amount = typeof row.Payment_Amount === 'number' ? row.Payment_Amount : null;
  const isTeamAffiliation = Boolean(row.Team) && row.Team !== 'GPSA';
  return {
    ad_id: row.Ad_ID,
    team: row.Team || null,
    ad_title: row.Ad_Title || '',
    advertiser: row.Company_Name || row.Advertiser_Name || '',
    placement: row.Placement || null,
    submitted_at: row.CreatedAt ?? null,
    status: row.Status || null,
    // Reason is only meaningful for — and only ever exposed on — rejected ads.
    reason: isRejected ? (row.Validation_Notes || '') : '',
    // Whether there's an image to view (drives the "view ad" affordance).
    has_artwork: Boolean(keyFromUri(row.Artwork_URI, bucket)),
    // Full ad price (cents). Not shown for rejected ads — they won't run / aren't charged.
    price_cents: isRejected ? null : amount,
    // What this ad contributes to the team's "due to GPSA": half of an APPROVED,
    // team-affiliated ad (50/50 split, PAY_TEAM). GPSA-affiliation ads are paid to GPSA
    // directly, so they owe nothing here.
    gpsa_due_cents: isApproved && isTeamAffiliation && amount ? Math.round(amount / 2) : 0,
  };
}

export function makeTeamHandlers(ctx) {
  const { noco, minio } = ctx;

  /** GET /api/team/ads[?include_rejected=true] — every ad's status, newest first. */
  async function ads(request, reply) {
    const includeRejected = request.query?.include_rejected === 'true';
    const visible = includeRejected ? WITH_REJECTED : DEFAULT_VISIBLE;

    const rows = await noco.listAds({ limit: 1000 });
    const list = rows
      .filter((r) => visible.has(r.Status))
      .map((r) => toTeamAd(r, minio.bucket))
      .sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
    return reply.send({ ads: list });
  }

  /** GET /api/team/ads/:adId/artwork — stream the current object bytes for viewing. */
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

  return { ads, artwork };
}
