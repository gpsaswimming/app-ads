// Treasurer report — the aggregation (reports/treasurer.js) and the PDF download
// (GET /admin-api/treasurer.pdf). docs/TODO.md #1.
//
// The arithmetic is tested directly on plain `Ads` rows so each case pins one billing rule
// (status, affiliation, placement, payment status); the endpoint tests cover the download
// itself — headers, filename, and that a page really is emitted per team.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTreasurerReport } from '../src/reports/treasurer.js';
import { renderTreasurerPdf, treasurerPdfFilename } from '../src/reports/treasurer-pdf.js';
import { makeTestApp } from './helpers.js';

const FULL = 9000;
const HALF = 5000;

let seq = 0;

/** One Ads row. Defaults: an approved, team-affiliated, unpaid full-screen ad. */
function row(overrides = {}) {
  seq += 1;
  return {
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
  };
}

const report = (rows) => buildTreasurerReport(rows, { meet: '2026 City Meet' });
const byTeam = (data, team) => data.teams.find((t) => t.team === team);

/** PDF page objects are plain in the file structure even when content streams are compressed. */
const pageCount = (buf) => buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g).length;

test('summarizes full/half counts per team and owes GPSA half of each approved ad', () => {
  const data = report([
    row({ Team: 'Glendale', Placement: 'FULL_SCREEN', Payment_Amount: FULL }),
    row({ Team: 'Glendale', Placement: 'HALF_SCREEN', Payment_Amount: HALF }),
    row({ Team: 'Glendale', Placement: 'HALF_SCREEN', Payment_Amount: HALF }),
    row({ Team: 'Poquoson', Placement: 'FULL_SCREEN', Payment_Amount: FULL }),
  ]);

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

test('GPSA-affiliation ads owe nothing — they are collected directly, and sort last', () => {
  const data = report([
    row({ Team: 'GPSA', Payment_Method: 'CHECK', Payment_Amount: FULL }),
    row({ Team: 'Wythe', Payment_Amount: FULL }),
  ]);

  const gpsa = byTeam(data, 'GPSA');
  assert.equal(gpsa.is_gpsa, true);
  assert.equal(gpsa.gpsa_due_cents, 0); // nobody owes GPSA its own ad
  assert.equal(gpsa.team_keeps_cents, 0);
  assert.equal(gpsa.gross_cents, FULL);
  assert.equal(data.teams.at(-1).team, 'GPSA'); // league group is the last page

  assert.equal(data.totals.gpsa_direct_cents, FULL);
  assert.equal(data.totals.gpsa_due_cents, FULL / 2); // only Wythe owes
  assert.equal(data.totals.team_count, 1); // GPSA is not a team
});

test('under-review ads are carried separately, never billed', () => {
  const colony = byTeam(report([
    row({ Team: 'Colony', Status: 'NEEDS_REVIEW', Payment_Amount: HALF }),
    row({ Team: 'Colony', Payment_Amount: FULL }),
  ]), 'Colony');

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

test('rejected and in-flight ads are left out of the report entirely', () => {
  const data = report([
    row({ Team: 'Marlbank', Status: 'REJECTED' }),
    row({ Team: 'Marlbank', Status: 'AWAITING_UPLOAD' }),
    row({ Team: 'Marlbank', Status: 'VALIDATING' }),
  ]);
  assert.equal(data.teams.length, 0);
  assert.equal(data.totals.gpsa_due_cents, 0);
});

test('unpaid tally chases PENDING only — PAID and WAIVED are settled', () => {
  const riverdale = byTeam(report([
    row({ Team: 'Riverdale', Payment_Status: 'PENDING', Payment_Amount: FULL }),
    row({ Team: 'Riverdale', Payment_Status: 'PAID', Payment_Amount: HALF }),
    row({ Team: 'Riverdale', Payment_Status: 'WAIVED', Payment_Amount: HALF }),
  ]), 'Riverdale');

  assert.equal(riverdale.unpaid_count, 1);
  assert.equal(riverdale.unpaid_cents, FULL);
  // Payment status never changes what the team owes GPSA — it's a gross obligation.
  assert.equal(riverdale.gpsa_due_cents, (FULL + HALF + HALF) / 2);
});

test("a team's page lists its ads newest-first with per-ad amount and share", () => {
  const wendwood = byTeam(report([
    row({ Team: 'Wendwood', CreatedAt: '2026-07-01T12:00:00Z', Ad_Title: 'Older' }),
    row({ Team: 'Wendwood', CreatedAt: '2026-07-20T12:00:00Z', Ad_Title: 'Newer' }),
    row({ Team: 'Kiln Creek', Ad_Title: 'Other team' }),
  ]), 'Wendwood');

  assert.deepEqual(wendwood.ads.map((a) => a.ad_title), ['Newer', 'Older']);
  assert.equal(wendwood.ads[0].amount_cents, FULL);
  assert.equal(wendwood.ads[0].gpsa_due_cents, FULL / 2);
  assert.equal(wendwood.ads[0].payment_status, 'PENDING');
  assert.equal(
    wendwood.ads.reduce((s, a) => s + a.gpsa_due_cents, 0),
    wendwood.gpsa_due_cents, // the page total matches the summary row
  );
});

test('report is empty (not an error) when nothing has been submitted', () => {
  const data = report([]);
  assert.deepEqual(data.teams, []);
  assert.equal(data.totals.ad_count, 0);
  assert.equal(data.totals.gpsa_due_cents, 0);
  assert.ok(data.generated_at);
  assert.equal(data.meet, '2026 City Meet');
});

test('PDF renders a summary page plus one page per team', async () => {
  const pdf = await renderTreasurerPdf(report([
    row({ Team: 'Glendale' }),
    row({ Team: 'Glendale', Placement: 'HALF_SCREEN', Payment_Amount: HALF }),
    row({ Team: 'Poquoson' }),
    row({ Team: 'GPSA', Payment_Method: 'CHECK' }),
  ]));

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(pdf), 4); // summary + Glendale + Poquoson + GPSA
});

test('PDF renders with no ads at all', async () => {
  const pdf = await renderTreasurerPdf(report([]));
  assert.equal(pageCount(pdf), 1); // just the summary, saying there is nothing yet
});

test('a team with many ads spills onto a continuation page', async () => {
  const many = Array.from({ length: 40 }, () => row({ Team: 'Hidenwood' }));
  const pdf = await renderTreasurerPdf(report(many));
  assert.ok(pageCount(pdf) > 2, 'summary + at least two pages for the long team');
});

test('GET /admin-api/treasurer.pdf downloads the report', async () => {
  const { app, noco } = makeTestApp();
  await noco.createAd(row({ Team: 'Glendale' }));
  await noco.createAd(row({ Team: 'GPSA', Payment_Method: 'CHECK' }));

  const res = await app.inject({ method: 'GET', url: '/admin-api/treasurer.pdf' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.match(res.headers['content-disposition'], /^attachment; filename="gpsa-treasurer-report-\d{4}-\d{2}-\d{2}\.pdf"$/);
  assert.equal(res.rawPayload.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(res.rawPayload), 3); // summary + Glendale + GPSA
});

test('the download filename carries the generation date', () => {
  const data = buildTreasurerReport([], { generatedAt: new Date('2026-07-29T15:04:05Z') });
  assert.equal(treasurerPdfFilename(data), 'gpsa-treasurer-report-2026-07-29.pdf');
});
