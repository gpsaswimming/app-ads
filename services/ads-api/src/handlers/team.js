// /api/team/* — the team-facing ad status list (DESIGN.md §12). Read-only, metadata only:
// a flat list of every ad's status across all teams. No app-level auth and no per-team
// scoping — like the admin tool, you land on the page and get the list. Exposure is a
// deployment choice (edge/network), not app logic. It never touches object storage and
// returns no payment data or submitter PII beyond the advertiser business name.

import { STATUS } from '../constants.js';

// Statuses shown. Transient in-flight states (AWAITING_UPLOAD / UPLOADED / VALIDATING) are
// hidden — they resolve within seconds and would only confuse. REJECTED is hidden unless
// the viewer opts in via ?include_rejected=true.
const DEFAULT_VISIBLE = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW]);
const WITH_REJECTED = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW, STATUS.REJECTED]);

/** Project a NocoDB Ads row to the minimal, safe shape the status list renders. */
function toTeamAd(row) {
  const isRejected = row.Status === STATUS.REJECTED;
  return {
    team: row.Team || null,
    ad_title: row.Ad_Title || '',
    advertiser: row.Company_Name || row.Advertiser_Name || '',
    placement: row.Placement || null,
    submitted_at: row.CreatedAt ?? null,
    status: row.Status || null,
    // Reason is only meaningful for — and only ever exposed on — rejected ads.
    reason: isRejected ? (row.Validation_Notes || '') : '',
  };
}

export function makeTeamHandlers(ctx) {
  const { noco } = ctx;

  /** GET /api/team/ads[?include_rejected=true] — every ad's status, newest first. */
  async function ads(request, reply) {
    const includeRejected = request.query?.include_rejected === 'true';
    const visible = includeRejected ? WITH_REJECTED : DEFAULT_VISIBLE;

    const rows = await noco.listAds({ limit: 1000 });
    const list = rows
      .filter((r) => visible.has(r.Status))
      .map(toTeamAd)
      .sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
    return reply.send({ ads: list });
  }

  return { ads };
}
