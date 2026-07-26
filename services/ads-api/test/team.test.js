// /api/team/ads — team-facing ad status list (DESIGN.md §12). Read-only, no app auth, no
// per-team scoping: a flat list of every ad's status. Covers status filtering, the rejected
// toggle, newest-first order, and the safe projection (no PII / payment / artwork leakage).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeNoco, makeTestApp } from './helpers.js';

// Seed a NocoDB fake with a spread of ads across teams and statuses. Sensitive fields are
// included so the projection tests can prove they never leak.
function seededNoco() {
  const noco = fakeNoco();
  const add = (o) => noco.createAd(o);
  add({
    Ad_ID: 'a1', Team: 'Wythe', Status: 'APPROVED', Ad_Title: "Joe's Pizza",
    Company_Name: "Joe's Pizza", Placement: 'FULL_SCREEN', CreatedAt: '2026-07-10T12:00:00Z',
    Submitter_Email: 'joe@example.com', Payment_Amount: 9000, Artwork_URI: 's3://gpsa-ads/a1/approved_x.png',
  });
  add({
    Ad_ID: 'a2', Team: 'Wythe', Status: 'NEEDS_REVIEW', Ad_Title: 'Bay Dental',
    Company_Name: 'Bay Dental', Placement: 'HALF_SCREEN', CreatedAt: '2026-07-14T12:00:00Z',
  });
  add({
    Ad_ID: 'a3', Team: 'Wythe', Status: 'REJECTED', Ad_Title: 'Ace Vaping',
    Company_Name: 'Ace Vaping', Placement: 'FULL_SCREEN', CreatedAt: '2026-07-15T12:00:00Z',
    Validation_Notes: 'Not permitted (adult product)',
  });
  add({
    Ad_ID: 'a4', Team: 'Wythe', Status: 'AWAITING_UPLOAD', Ad_Title: 'Half-done',
    Company_Name: 'Half-done', Placement: 'FULL_SCREEN', CreatedAt: '2026-07-16T12:00:00Z',
  });
  add({
    Ad_ID: 'b1', Team: 'Glendale', Status: 'APPROVED', Ad_Title: 'Other Team Ad',
    Company_Name: 'Other Team Ad', Placement: 'FULL_SCREEN', CreatedAt: '2026-07-11T12:00:00Z',
  });
  return noco;
}

const appWith = () => makeTestApp({ noco: seededNoco() });

test('ads: default = approved + under review across ALL teams, excludes rejected/transient', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads' });
  assert.equal(res.statusCode, 200);
  const titles = res.json().ads.map((a) => a.ad_title).sort();
  assert.deepEqual(titles, ['Bay Dental', "Joe's Pizza", 'Other Team Ad']); // a1 + a2 + b1
  assert.ok(!titles.includes('Ace Vaping'), 'rejected hidden by default');
  assert.ok(!titles.includes('Half-done'), 'transient hidden');
});

test('ads: rows carry the team so a viewer can tell whose ad it is', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads' });
  const teams = new Set(res.json().ads.map((a) => a.team));
  assert.ok(teams.has('Wythe') && teams.has('Glendale'));
});

test('ads: newest first', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?include_rejected=true' });
  const dates = res.json().ads.map((a) => a.submitted_at);
  const sorted = [...dates].sort((x, y) => String(y).localeCompare(String(x)));
  assert.deepEqual(dates, sorted);
});

test('ads: include_rejected=true adds rejected rows with their reason', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?include_rejected=true' });
  const rejected = res.json().ads.find((a) => a.ad_title === 'Ace Vaping');
  assert.ok(rejected, 'rejected ad now present');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'Not permitted (adult product)');
});

test('ads: reason is only exposed on rejected rows', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?include_rejected=true' });
  const approved = res.json().ads.find((a) => a.ad_title === "Joe's Pizza");
  assert.equal(approved.reason, '');
});

test('ads: projection never leaks PII / payment / artwork URI', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads' });
  const ad = res.json().ads[0];
  assert.deepEqual(
    Object.keys(ad).sort(),
    ['ad_id', 'ad_title', 'advertiser', 'has_artwork', 'placement', 'reason', 'status', 'submitted_at', 'team'],
  );
  const serialized = JSON.stringify(res.json());
  assert.ok(!serialized.includes('joe@example.com'), 'no submitter email');
  assert.ok(!serialized.includes('9000'), 'no payment amount');
  assert.ok(!serialized.includes('s3://'), 'no raw artwork URI (only a has_artwork flag)');
});

test('ads: has_artwork reflects whether an object is present', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads' });
  const ads = res.json().ads;
  assert.equal(ads.find((a) => a.ad_title === "Joe's Pizza").has_artwork, true);   // a1 has Artwork_URI
  assert.equal(ads.find((a) => a.ad_title === 'Bay Dental').has_artwork, false);    // a2 has none
});

test('artwork: streams the object bytes for an ad that has one', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads/a1/artwork' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.ok(res.rawPayload.length > 0);
});

test('artwork: 404 for an unknown ad', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads/nope/artwork' });
  assert.equal(res.statusCode, 404);
});

test('artwork: 404 when the ad has no uploaded object', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads/a2/artwork' });
  assert.equal(res.statusCode, 404);
});
