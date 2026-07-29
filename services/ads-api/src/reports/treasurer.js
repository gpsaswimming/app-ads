// Treasurer report — what each team owes GPSA (docs/TODO.md #1).
//
// This module does the arithmetic; `treasurer-pdf.js` renders it. The dashboard never
// computes money — it just downloads the PDF.
//
// What counts: APPROVED ads are billable. NEEDS_REVIEW ads are carried alongside as "could
// still land" so a report run mid-season isn't misleading. Rejected and in-flight ads
// (AWAITING_UPLOAD / VALIDATING) are money that does not exist and are left out entirely.

import { amountCents, gpsaDueCents, isTeamAffiliated } from '../billing.js';
import { STATUS } from '../constants.js';

const BILLABLE = STATUS.APPROVED;
const PENDING = STATUS.NEEDS_REVIEW;

/** One line of a team's page. */
function toLine(row) {
  return {
    ad_id: row.Ad_ID,
    submitted_at: row.CreatedAt ?? null,
    status: row.Status,
    company_name: row.Company_Name || '',
    ad_title: row.Ad_Title || '',
    placement: row.Placement || null,
    payment_method: row.Payment_Method || null,
    // Tracked for league invoices only — null on a team ad, which the team collects itself.
    payment_status: isTeamAffiliated(row) ? null : (row.Payment_Status || null),
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
    // LEAGUE ADS ONLY: approved GPSA-affiliation invoices not settled yet (Payment_Status
    // other than PAID/WAIVED) — the treasurer's chase list. Team ads stay 0: the team
    // collects from its advertiser and GPSA never sees that transaction, so there is
    // nothing to chase and nothing that would change the team's 50% remittance.
    unpaid_count: 0,
    unpaid_cents: 0,
    // Still under review: not counted anywhere above, listed so the report reads honestly
    // mid-season ("one more could still land").
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
  if (isTeamAffiliated(row)) {
    group.team_keeps_cents += (line.amount_cents || 0) - line.gpsa_due_cents;
  } else if (row.Payment_Status !== 'PAID' && row.Payment_Status !== 'WAIVED') {
    group.unpaid_count += 1;
    group.unpaid_cents += line.amount_cents || 0;
  }
}

/**
 * Aggregate raw `Ads` rows into the report: one group per affiliation (each with its own
 * ad lines, which become that team's page) plus league-wide totals.
 */
export function buildTreasurerReport(rows, { meet = null, generatedAt = new Date() } = {}) {
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

  return { meet, generated_at: generatedAt.toISOString(), teams, totals };
}
