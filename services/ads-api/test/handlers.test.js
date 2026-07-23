import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTestApp, testConfig, uploadedEvent, validSubmitBody } from './helpers.js';

const AUTH = { authorization: 'Bearer test-webhook-secret' };

test('GET /health returns ok', async () => {
  const { app } = makeTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('POST /api/submit happy path creates a row and returns a presign', async () => {
  const { app, noco, minio } = makeTestApp();
  const res = await app.inject({ method: 'POST', url: '/api/submit', payload: validSubmitBody() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.ad_id);
  assert.ok(body.presign.url.includes('ads-upload'));
  assert.equal(minio.calls.presign.length, 1);

  const row = noco.rows.get(body.ad_id);
  assert.equal(row.Status, 'AWAITING_UPLOAD');
  assert.equal(row.Payment_Amount, 7500); // FULL_SCREEN
  assert.equal(row.Rights_Confirmed, true);
  assert.ok(row.Rights_Confirmed_At);
  assert.equal(row.Meet, '2026 City Meet');
});

test('POST /api/submit is rejected after the deadline (before anything else)', async () => {
  const { app, noco } = makeTestApp({
    config: testConfig({ submissionDeadlineMs: Date.now() - 1000 }),
  });
  const res = await app.inject({ method: 'POST', url: '/api/submit', payload: validSubmitBody() });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SUBMISSIONS_CLOSED');
  assert.equal(noco.rows.size, 0); // nothing created
});

test('POST /api/submit rejects a failed Turnstile with no row created', async () => {
  const { app, noco } = makeTestApp({ verifyTurnstile: async () => false });
  const res = await app.inject({ method: 'POST', url: '/api/submit', payload: validSubmitBody() });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'TURNSTILE_FAILED');
  assert.equal(noco.rows.size, 0);
});

test('POST /api/submit rejects invalid input (missing rights) with 400', async () => {
  const { app, noco } = makeTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/submit',
    payload: validSubmitBody({ rights_confirmed: false }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'VALIDATION_FAILED');
  assert.equal(noco.rows.size, 0);
});

test('POST /api/submit rejects a bad payment method for the affiliation', async () => {
  const { app } = makeTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/submit',
    payload: validSubmitBody({ payment_method: 'CHECK' }), // team ⇒ must be PAY_TEAM
  });
  assert.equal(res.statusCode, 400);
});

// --- /internal/uploaded ---

async function submitOne(app) {
  const res = await app.inject({ method: 'POST', url: '/api/submit', payload: validSubmitBody() });
  return res.json().ad_id;
}

test('POST /internal/uploaded rejects a wrong shared secret', async () => {
  const { app } = makeTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/internal/uploaded',
    headers: { authorization: 'Bearer wrong' },
    payload: uploadedEvent('any-id'),
  });
  assert.equal(res.statusCode, 401);
});

test('POST /internal/uploaded approves: rename + APPROVED + emails', async () => {
  const { app, noco, minio, mailer } = makeTestApp();
  const adId = await submitOne(app);

  const res = await app.inject({
    method: 'POST',
    url: '/internal/uploaded',
    headers: AUTH,
    payload: uploadedEvent(adId),
  });
  assert.equal(res.statusCode, 200);

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'APPROVED');
  assert.match(row.Artwork_URI, /approved_/);
  assert.equal(minio.calls.rename.length, 1);
  assert.equal(mailer.outcome.at(-1).status, 'APPROVED');
  assert.equal(mailer.internal.at(-1).status, 'APPROVED');
});

test('POST /internal/uploaded rejects bad dimensions', async () => {
  const { app, noco, minio, mailer } = makeTestApp({
    validateDimensions: async () => ({ ok: false, width: 2000, height: 1200, reason: '2000×1200 wrong aspect' }),
  });
  const adId = await submitOne(app);

  await app.inject({ method: 'POST', url: '/internal/uploaded', headers: AUTH, payload: uploadedEvent(adId) });

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'REJECTED');
  assert.match(row.Validation_Notes, /wrong aspect/);
  assert.equal(minio.calls.rename.length, 0); // never renamed
  assert.equal(mailer.outcome.at(-1).status, 'REJECTED');
});

test('POST /internal/uploaded routes to NEEDS_REVIEW when Gemini errors (fail-safe)', async () => {
  const { app, noco, minio, mailer } = makeTestApp({
    checkAppropriateness: async () => {
      throw new Error('gemini timeout');
    },
  });
  const adId = await submitOne(app);

  await app.inject({ method: 'POST', url: '/internal/uploaded', headers: AUTH, payload: uploadedEvent(adId) });

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'NEEDS_REVIEW');
  assert.equal(minio.calls.rename.length, 0);
  assert.equal(mailer.outcome.at(-1).status, 'NEEDS_REVIEW');
});

test('POST /internal/uploaded routes to NEEDS_REVIEW when Gemini flags it', async () => {
  const { app, noco } = makeTestApp({
    checkAppropriateness: async () => ({ appropriate: false, reason: 'not an advertisement' }),
  });
  const adId = await submitOne(app);

  await app.inject({ method: 'POST', url: '/internal/uploaded', headers: AUTH, payload: uploadedEvent(adId) });

  const row = noco.rows.get(adId);
  assert.equal(row.Status, 'NEEDS_REVIEW');
  assert.match(row.Validation_Notes, /not an advertisement/);
});

test('POST /internal/uploaded ignores keys without pending_', async () => {
  const { app } = makeTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/internal/uploaded',
    headers: AUTH,
    payload: {
      Records: [
        { eventName: 's3:ObjectCreated:Put', s3: { object: { key: 'some-id/approved_x.png' } } },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ignored, true);
});
