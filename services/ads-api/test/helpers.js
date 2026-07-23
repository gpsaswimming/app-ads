// Test harness: build the real Fastify app with fake external clients so handlers can
// be driven end-to-end (via app.inject) with no network. Each fake is overridable.

import { buildApp } from '../src/app.js';
import { createSubmitValidator } from '../src/validation/submit-schema.js';

const MAX_BYTES = 52428800;

export function fakeNoco() {
  const rows = new Map(); // Ad_ID -> row (with an assigned Id)
  let nextId = 1;
  return {
    rows,
    async createAd(fields) {
      const Id = nextId++;
      const row = { Id, ...fields };
      rows.set(fields.Ad_ID, row);
      return row;
    },
    async updateAd(recordId, fields) {
      for (const row of rows.values()) {
        if (row.Id === recordId) {
          Object.assign(row, fields);
          return row;
        }
      }
      throw new Error(`no row with Id ${recordId}`);
    },
    async findByAdId(adId) {
      return rows.get(adId) || null;
    },
  };
}

export function fakeMinio(overrides = {}) {
  const calls = { presign: [], rename: [], get: [] };
  return {
    calls,
    bucket: 'gpsa-ads',
    async presignUpload(adId, filename, contentType) {
      calls.presign.push({ adId, filename, contentType });
      return {
        url: 'https://ads-upload.gpsaswimming.org/gpsa-ads',
        fields: { key: `${adId}/pending_${filename}`, 'Content-Type': contentType },
        key: `${adId}/pending_${filename}`,
      };
    },
    async getObjectBuffer(key) {
      calls.get.push(key);
      return overrides.buffer || Buffer.from('fake-image-bytes');
    },
    async renameToApproved(key) {
      calls.rename.push(key);
      return key.replace('/pending_', '/approved_');
    },
    ...overrides.methods,
  };
}

export function fakeMailer() {
  const outcome = [];
  const internal = [];
  return {
    outcome,
    internal,
    async sendOutcome(row) {
      outcome.push({ status: row.Status, to: row.Submitter_Email, adId: row.Ad_ID });
    },
    async sendInternal(row) {
      internal.push({ status: row.Status, adId: row.Ad_ID });
    },
  };
}

export function testConfig(overrides = {}) {
  return {
    submissionDeadlineMs: Date.now() + 86400000, // open by default
    meetName: '2026 City Meet',
    pricing: { FULL_SCREEN: 7500, HALF_SCREEN: 4000 },
    minio: { webhookSecret: 'test-webhook-secret' },
    ...overrides,
  };
}

export function makeTestApp(overrides = {}) {
  const noco = overrides.noco || fakeNoco();
  const minio = overrides.minio || fakeMinio();
  const mailer = overrides.mailer || fakeMailer();
  const config = overrides.config || testConfig();

  const ctx = {
    config,
    verifyTurnstile: overrides.verifyTurnstile || (async () => true),
    validateSubmit: createSubmitValidator(MAX_BYTES),
    noco,
    minio,
    mailer,
    validateDimensions: overrides.validateDimensions || (async () => ({ ok: true, width: 2700, height: 1200, reason: null })),
    checkAppropriateness: overrides.checkAppropriateness || (async () => ({ appropriate: true, reason: 'looks like an ad' })),
  };

  const app = buildApp(ctx, { logger: false });
  return { app, noco, minio, mailer, config };
}

export function validSubmitBody(overrides = {}) {
  return {
    submitter_name: 'Joe Smith',
    submitter_email: 'joe@example.com',
    submitter_is_advertiser: true,
    company_name: "Joe's Pizza",
    advertiser_name: 'Joe Smith',
    advertiser_email: 'joe@example.com',
    team: 'Glendale',
    ad_title: "Joe's Pizza — Summer Special",
    placement: 'FULL_SCREEN',
    payment_method: 'PAY_TEAM',
    rights_confirmed: true,
    filename: 'summer-special.png',
    content_type: 'image/png',
    byte_size: 1048576,
    turnstile_token: 'tok-abc',
    ...overrides,
  };
}

export function uploadedEvent(adId, filename = 'summer-special.png', extra = {}) {
  return {
    Records: [
      {
        eventName: 's3:ObjectCreated:Post',
        s3: {
          bucket: { name: 'gpsa-ads' },
          object: { key: `${adId}/pending_${filename}`, size: 1048576, contentType: 'image/png', ...extra },
        },
      },
    ],
  };
}
