import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestApp, uploadedEvent, validSubmitBody } from './helpers.js';

const WEBHOOK = { authorization: 'Bearer test-webhook-secret' };

/** Submit one ad; returns its Ad_ID (status AWAITING_UPLOAD, no artwork yet). */
async function submitOne(app, overrides) {
  const res = await app.inject({ method: 'POST', url: '/api/submit', payload: validSubmitBody(overrides) });
  return res.json().ad_id;
}

/** Submit then drive the upload webhook so the ad reaches NEEDS_REVIEW with a pending_ object. */
async function submitToNeedsReview(app) {
  const adId = await submitOne(app);
  await app.inject({
    method: 'POST',
    url: '/internal/uploaded',
    headers: WEBHOOK,
    payload: uploadedEvent(adId),
  });
  return adId;
}

// checkAppropriateness that flags → the uploaded handler routes to NEEDS_REVIEW.
const flagIt = { checkAppropriateness: async () => ({ appropriate: false, reason: 'flagged in test' }) };

test('GET /admin-api/ads lists submissions as summaries', async () => {
  const { app } = makeTestApp();
  await submitOne(app);
  await submitOne(app, { company_name: 'Second Co', team: 'Poquoson', payment_method: 'PAY_TEAM' });

  const res = await app.inject({ method: 'GET', url: '/admin-api/ads' });
  assert.equal(res.statusCode, 200);
  const { ads } = res.json();
  assert.equal(ads.length, 2);
  const a = ads[0];
  assert.ok(a.ad_id);
  assert.equal(a.status, 'AWAITING_UPLOAD');
  assert.equal(a.has_artwork, false); // nothing uploaded yet
  assert.equal(a.payment_amount, 7500);
  // PII is present (VPN-only) but no secret/internal columns leak in.
  assert.ok(a.submitter_email);
  assert.equal(a.Artwork_URI, undefined);
});

test('GET /admin-api/ads/:adId/artwork streams the object with its content-type', async () => {
  const { app } = makeTestApp(flagIt);
  const adId = await submitToNeedsReview(app);

  const res = await app.inject({ method: 'GET', url: `/admin-api/ads/${adId}/artwork` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.ok(res.rawPayload.length > 0);
});

test('GET artwork → 404 when the ad has no uploaded artwork', async () => {
  const { app } = makeTestApp();
  const adId = await submitOne(app);
  const res = await app.inject({ method: 'GET', url: `/admin-api/ads/${adId}/artwork` });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'NO_ARTWORK');
});

test('POST approve renames pending_→approved_, sets APPROVED, emails the submitter', async () => {
  const { app, noco, minio, mailer } = makeTestApp(flagIt);
  const adId = await submitToNeedsReview(app);
  assert.equal(noco.rows.get(adId).Status, 'NEEDS_REVIEW');
  const renamesBefore = minio.calls.rename.length;

  const res = await app.inject({ method: 'POST', url: `/admin-api/ads/${adId}/approve` });
  assert.equal(res.statusCode, 200);

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'APPROVED');
  assert.match(row.Artwork_URI, /approved_/);
  assert.equal(minio.calls.rename.length, renamesBefore + 1);
  assert.equal(mailer.outcome.at(-1).status, 'APPROVED');
  assert.equal(res.json().ad.has_artwork, true);
});

test('POST approve tolerates a JSON content-type with an empty body (browser bare POST)', async () => {
  const { app, noco } = makeTestApp(flagIt);
  const adId = await submitToNeedsReview(app);

  // Reproduce the dashboard's original request: application/json header, no body.
  const res = await app.inject({
    method: 'POST',
    url: `/admin-api/ads/${adId}/approve`,
    headers: { 'content-type': 'application/json' },
    payload: '',
  });
  assert.equal(res.statusCode, 200); // not 400 FST_ERR_CTP_EMPTY_JSON_BODY
  assert.equal(noco.rows.get(adId).Status, 'APPROVED');
});

test('POST approve is idempotent — a second call does not rename again', async () => {
  const { app, minio } = makeTestApp(flagIt);
  const adId = await submitToNeedsReview(app);

  await app.inject({ method: 'POST', url: `/admin-api/ads/${adId}/approve` });
  const afterFirst = minio.calls.rename.length;
  const res = await app.inject({ method: 'POST', url: `/admin-api/ads/${adId}/approve` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ad.status, 'APPROVED');
  assert.equal(minio.calls.rename.length, afterFirst); // no second rename
});

test('POST approve → 409 when nothing has been uploaded', async () => {
  const { app, minio } = makeTestApp();
  const adId = await submitOne(app);
  const res = await app.inject({ method: 'POST', url: `/admin-api/ads/${adId}/approve` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'NO_ARTWORK');
  assert.equal(minio.calls.rename.length, 0);
});

test('POST deny sets REJECTED with the reason and emails the submitter', async () => {
  const { app, noco, minio, mailer } = makeTestApp(flagIt);
  const adId = await submitToNeedsReview(app);

  const res = await app.inject({
    method: 'POST',
    url: `/admin-api/ads/${adId}/deny`,
    payload: { reason: 'Off-brand imagery' },
  });
  assert.equal(res.statusCode, 200);

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'REJECTED');
  assert.equal(row.Validation_Notes, 'Off-brand imagery');
  assert.equal(minio.calls.rename.length, 0); // deny never renames
  assert.equal(mailer.outcome.at(-1).status, 'REJECTED');
});

test('POST deny with no reason falls back to a default note', async () => {
  const { app, noco } = makeTestApp();
  const adId = await submitOne(app);
  await app.inject({ method: 'POST', url: `/admin-api/ads/${adId}/deny`, payload: {} });
  assert.equal(noco.rows.get(adId).Validation_Notes, 'Not approved for display');
});

test('admin actions on an unknown Ad_ID → 404', async () => {
  const { app } = makeTestApp();
  for (const url of ['/admin-api/ads/nope/artwork', '/admin-api/ads/nope/approve', '/admin-api/ads/nope/deny']) {
    const method = url.endsWith('artwork') ? 'GET' : 'POST';
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    assert.equal(res.statusCode, 404, url);
  }
});
