// /api/team/* — team-facing ad view (DESIGN.md §12). Drives the real Fastify app with
// fake NocoDB + Reps clients. Covers auth (identity header), authorization (scope must be
// in the caller's allowlist), status filtering, the rejected toggle, and the safe
// projection (no PII / payment / artwork leakage).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeNoco, fakeReps, makeTestApp } from './helpers.js';

const IDH = 'x-forwarded-email';

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

function appWith(overrides = {}) {
  return makeTestApp({
    noco: seededNoco(),
    reps: fakeReps({ 'rep@wythe.org': ['Wythe'], 'board@gpsa.org': ['Wythe', 'GPSA'] }),
    ...overrides,
  });
}

// ---- scopes ----

test('scopes: 401 without an identity header', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/scopes' });
  assert.equal(res.statusCode, 401);
});

test('scopes: returns the caller\'s affiliations', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/scopes', headers: { [IDH]: 'board@gpsa.org' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().affiliations, ['Wythe', 'GPSA']);
});

test('scopes: unknown email → 200 with empty affiliations (UI shows access-denied)', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/scopes', headers: { [IDH]: 'stranger@nowhere.org' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().affiliations, []);
});

test('scopes: email match is case-insensitive', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/scopes', headers: { [IDH]: 'REP@Wythe.org' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().affiliations, ['Wythe']);
});

// ---- ads: auth / authz ----

test('ads: 401 without an identity header', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe' });
  assert.equal(res.statusCode, 401);
});

test('ads: 400 when team is missing', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(res.statusCode, 400);
});

test('ads: 403 when requesting an affiliation the caller is not authorized for', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Glendale', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(res.statusCode, 403);
});

// ---- ads: filtering / projection ----

test('ads: default view = approved + under review, excludes rejected/transient/other teams', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(res.statusCode, 200);
  const { ads } = res.json();
  const titles = ads.map((a) => a.ad_title).sort();
  assert.deepEqual(titles, ['Bay Dental', "Joe's Pizza"]); // a1 + a2 only
  assert.ok(!titles.includes('Ace Vaping'), 'rejected hidden');
  assert.ok(!titles.includes('Half-done'), 'transient hidden');
  assert.ok(!titles.includes('Other Team Ad'), 'other team hidden');
});

test('ads: include_rejected=true adds rejected rows with their reason', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe&include_rejected=true', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(res.statusCode, 200);
  const { ads } = res.json();
  const rejected = ads.find((a) => a.ad_title === 'Ace Vaping');
  assert.ok(rejected, 'rejected ad now present');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'Not permitted (adult product)');
});

test('ads: reason is only exposed on rejected rows', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe&include_rejected=true', headers: { [IDH]: 'rep@wythe.org' } });
  const approved = res.json().ads.find((a) => a.ad_title === "Joe's Pizza");
  assert.equal(approved.reason, '');
});

test('ads: projection never leaks PII / payment / artwork fields', async () => {
  const { app } = appWith();
  const res = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe', headers: { [IDH]: 'rep@wythe.org' } });
  const ad = res.json().ads[0];
  assert.deepEqual(
    Object.keys(ad).sort(),
    ['ad_title', 'advertiser', 'placement', 'reason', 'status', 'submitted_at'],
  );
  const serialized = JSON.stringify(res.json());
  assert.ok(!serialized.includes('joe@example.com'), 'no submitter email');
  assert.ok(!serialized.includes('9000'), 'no payment amount');
  assert.ok(!serialized.includes('s3://'), 'no artwork URI');
});

// ---- feature gating ----

test('scopes + ads: 503 when the Reps table is not configured', async () => {
  const { app } = appWith({ reps: null });
  const s = await app.inject({ method: 'GET', url: '/api/team/scopes', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(s.statusCode, 503);
  const a = await app.inject({ method: 'GET', url: '/api/team/ads?team=Wythe', headers: { [IDH]: 'rep@wythe.org' } });
  assert.equal(a.statusCode, 503);
});
