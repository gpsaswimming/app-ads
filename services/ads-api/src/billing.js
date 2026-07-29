// Money rules for the 50/50 split (DESIGN.md §4 "Payment rules").
//
// Single source of truth for "what does this ad contribute", shared by the team status list
// (`/api/team/ads`) and the treasurer report (`/admin-api/treasurer`) so the two can never
// drift. Nothing here reads config — the per-placement rate is already stamped onto the row
// as `Payment_Amount` at submission time, which is what a season-old ad must be billed at.

import { STATUS } from './constants.js';

/** Team-affiliated (not the league) → the 50/50 split applies. */
export function isTeamAffiliated(row) {
  return Boolean(row.Team) && row.Team !== 'GPSA';
}

/** The ad's full rate in cents, or null when the row has no amount. */
export function amountCents(row) {
  return typeof row.Payment_Amount === 'number' ? row.Payment_Amount : null;
}

/**
 * What this ad contributes to its team's "due to GPSA": half of an APPROVED,
 * team-affiliated ad (the advertiser pays the team; the team remits GPSA's share).
 * GPSA-affiliation ads are paid to GPSA directly and un-approved ads aren't billed, so
 * both contribute 0.
 *
 * This is a **gross** obligation: `Payment_Status` tracks whether the advertiser has paid,
 * which does not change what the team owes GPSA.
 */
export function gpsaDueCents(row) {
  const amount = amountCents(row);
  if (row.Status !== STATUS.APPROVED || !isTeamAffiliated(row) || !amount) return 0;
  return Math.round(amount / 2);
}
