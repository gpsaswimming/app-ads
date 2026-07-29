// GET /admin-api/treasurer — the per-team money report (docs/TODO.md #1).
// Rows are seeded straight into the fake NocoDB so each case pins one billing rule
// (status, affiliation, placement, payment status) without driving the whole intake flow.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestApp } from './helpers.js';

const FULL = 9000;
const HALF = 5000;

let seq = 0;

/** Seed one Ads row. Defaults: an approved, team-affiliated, unpaid full-screen ad. */
function ad(noco, overrides = {}) {
  seq += 1;
  return noco.createAd({
    Ad_ID: `ad-${seq}`,
    CreatedAt: `2026-07-${String(10 + seq).padStart(2, '0')}T12:00:00Z`,
    Status: 'APPROVED',
    Team: 'Glendale',
    Company_Name: `Advertiser ${seq}`,
    Ad_Title: `Ad ${seq}`,
    Placement: 'FULL_SCREEN',
    Payment_Method: 'PAY_TEAM',
    Payment_Amount: FULL,
    Payment_Status: 'PENDING',
    ...overrides,
  });
}

async function report(app) {
  const res = await app.inject({ method: 'GET', url: '/admin-api/treasurer' });
  assert.equal(res.statusCode, 200);
  return res.json();
}

const byTeam = (data, team) => data.teams.find((t) => t.team === team);

test('summarizes full/half counts per team and owes GPSA half of each approved ad', async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'Glendale', Placement: 'FULL_SCREEN', Payment_Amount: FULL });
  await ad(noco, { Team: 'Glendale', Placement: 'HALF_SCREEN', Payment_Amount: HALF });
  await ad(noco, { Team: 'Glendale', Placement: 'HALF_SCREEN', Payment_Amount: HALF });
  await ad(noco, { Team: 'Poquoson', Placement: 'FULL_SCREEN', Payment_Amount: FULL });

  const data = await report(app);

  const glendale = byTeam(data, 'Glendale');
  assert.equal(glendale.full_count, 1);
  assert.equal(glendale.half_count, 2);
  assert.equal(glendale.ad_count, 3);
  assert.equal(glendale.gross_cents, FULL + HALF + HALF);
  assert.equal(glendale.gpsa_due_cents, (FULL + HALF + HALF) / 2);
  assert.equal(glendale.team_keeps_cents, (FULL + HALF + HALF) / 2);

  assert.equal(byTeam(data, 'Poquoson').gpsa_due_cents, FULL / 2);
  assert.equal(data.totals.gpsa_due_cents, (FULL + HALF + HALF) / 2 + FULL / 2);
  assert.equal(data.totals.team_count, 2);
  assert.equal(data.totals.full_count, 2);
  assert.equal(data.totals.half_count, 2);
});

test('GPSA-affiliation ads owe nothing — they are collected directly, and sort last', async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'GPSA', Payment_Method: 'CHECK', Payment_Amount: FULL });
  await ad(noco, { Team: 'Wythe', Payment_Amount: FULL });

  const data = await report(app);

  const gpsa = byTeam(data, 'GPSA');
  assert.equal(gpsa.is_gpsa, true);
  assert.equal(gpsa.gpsa_due_cents, 0); // nobody owes GPSA its own ad
  assert.equal(gpsa.team_keeps_cents, 0);
  assert.equal(gpsa.gross_cents, FULL);
  assert.equal(data.teams.at(-1).team, 'GPSA'); // league group is the footnote

  assert.equal(data.totals.gpsa_direct_cents, FULL);
  assert.equal(data.totals.gpsa_due_cents, FULL / 2); // only Wythe owes
  assert.equal(data.totals.team_count, 1); // GPSA is not a team
});

test('under-review ads are carried separately, never billed', async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'Colony', Status: 'NEEDS_REVIEW', Payment_Amount: HALF });
  await ad(noco, { Team: 'Colony', Payment_Amount: FULL });

  const colony = byTeam(await report(app), 'Colony');
  assert.equal(colony.ad_count, 1); // the approved one
  assert.equal(colony.gross_cents, FULL);
  assert.equal(colony.gpsa_due_cents, FULL / 2);
  assert.equal(colony.pending_count, 1);
  assert.equal(colony.pending_cents, HALF);

  // It still appears on the team page — with no money attributed to it.
  const line = colony.ads.find((a) => a.status === 'NEEDS_REVIEW');
  assert.equal(line.amount_cents, HALF);
  assert.equal(line.gpsa_due_cents, 0);
});

test('rejected and in-flight ads are left out of the report entirely', async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'Marlbank', Status: 'REJECTED' });
  await ad(noco, { Team: 'Marlbank', Status: 'AWAITING_UPLOAD' });
  await ad(noco, { Team: 'Marlbank', Status: 'VALIDATING' });

  const data = await report(app);
  assert.equal(data.teams.length, 0);
  assert.equal(data.totals.gpsa_due_cents, 0);
});

test('unpaid tally chases PENDING only — PAID and WAIVED are settled', async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'Riverdale', Payment_Status: 'PENDING', Payment_Amount: FULL });
  await ad(noco, { Team: 'Riverdale', Payment_Status: 'PAID', Payment_Amount: HALF });
  await ad(noco, { Team: 'Riverdale', Payment_Status: 'WAIVED', Payment_Amount: HALF });

  const riverdale = byTeam(await report(app), 'Riverdale');
  assert.equal(riverdale.unpaid_count, 1);
  assert.equal(riverdale.unpaid_cents, FULL);
  // Payment status never changes what the team owes GPSA — it's a gross obligation.
  assert.equal(riverdale.gpsa_due_cents, (FULL + HALF + HALF) / 2);
});

test("a team's page lists its ads newest-first with per-ad amount and share", async () => {
  const { app, noco } = makeTestApp();
  await ad(noco, { Team: 'Wendwood', CreatedAt: '2026-07-01T12:00:00Z', Ad_Title: 'Older' });
  await ad(noco, { Team: 'Wendwood', CreatedAt: '2026-07-20T12:00:00Z', Ad_Title: 'Newer' });
  await ad(noco, { Team: 'Kiln Creek', Ad_Title: 'Other team' });

  const wendwood = byTeam(await report(app), 'Wendwood');
  assert.deepEqual(wendwood.ads.map((a) => a.ad_title), ['Newer', 'Older']);
  assert.equal(wendwood.ads[0].amount_cents, FULL);
  assert.equal(wendwood.ads[0].gpsa_due_cents, FULL / 2);
  assert.equal(wendwood.ads[0].payment_status, 'PENDING');
  assert.equal(
    wendwood.ads.reduce((s, a) => s + a.gpsa_due_cents, 0),
    wendwood.gpsa_due_cents, // the page footer matches the summary row
  );
});

test('report is empty (not an error) when nothing has been submitted', async () => {
  const { app } = makeTestApp();
  const data = await report(app);
  assert.deepEqual(data.teams, []);
  assert.equal(data.totals.ad_count, 0);
  assert.equal(data.totals.gpsa_due_cents, 0);
  assert.ok(data.generated_at);
  assert.equal(data.meet, '2026 City Meet');
});
