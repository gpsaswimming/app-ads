import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

function fullEnv(over = {}) {
  return {
    MINIO_ENDPOINT_INTERNAL: 'http://minio.gpsa.local:9000',
    MINIO_ENDPOINT_PUBLIC: 'https://ads-upload.gpsaswimming.org',
    MINIO_ACCESS_KEY: 'ak',
    MINIO_SECRET_KEY: 'sk',
    MINIO_TO_API_SECRET: 'shared',
    NOCODB_URL: 'http://nocodb.gpsa.local:8080/',
    NOCODB_TOKEN: 'tok',
    NOCODB_BASE_ID: 'base',
    NOCODB_ADS_TABLE_ID: 'tbl',
    TURNSTILE_SECRET: 'ts',
    GEMINI_API_KEY: 'gk',
    SMTP_URL: 'smtp://user:pass@mail:587',
    ADS_NOTIFY_EMAIL: 'chair@example.org',
    GPSA_CHECK_ADDRESS: 'PO Box 1',
    SUBMISSION_DEADLINE: '2026-07-31T23:59:59-04:00',
    ...over,
  };
}

test('loads a complete env and applies defaults', () => {
  const cfg = loadConfig(fullEnv());
  assert.equal(cfg.minio.bucket, 'gpsa-ads');
  assert.equal(cfg.pricing.FULL_SCREEN, 9000);
  assert.equal(cfg.pricing.HALF_SCREEN, 5000);
  assert.equal(cfg.gemini.model, 'gemini-2.5-flash');
  assert.equal(cfg.nocodb.url, 'http://nocodb.gpsa.local:8080'); // trailing slash stripped
  assert.ok(Number.isFinite(cfg.submissionDeadlineMs));
});

test('fails fast listing every missing required key', () => {
  const env = fullEnv();
  delete env.TURNSTILE_SECRET;
  delete env.GEMINI_API_KEY;
  assert.throws(() => loadConfig(env), (err) => {
    assert.match(err.message, /TURNSTILE_SECRET/);
    assert.match(err.message, /GEMINI_API_KEY/);
    return true;
  });
});

test('rejects an unparseable deadline', () => {
  assert.throws(() => loadConfig(fullEnv({ SUBMISSION_DEADLINE: 'not-a-date' })), /SUBMISSION_DEADLINE/);
});

test('rejects a bad notify email', () => {
  assert.throws(() => loadConfig(fullEnv({ ADS_NOTIFY_EMAIL: 'nope' })), /ADS_NOTIFY_EMAIL/);
});

test('overrides prices and model from env', () => {
  const cfg = loadConfig(fullEnv({ PRICE_FULL_CENTS: '9000', PRICE_HALF_CENTS: '5000', GEMINI_MODEL: 'gemini-flash-latest' }));
  assert.equal(cfg.pricing.FULL_SCREEN, 9000);
  assert.equal(cfg.pricing.HALF_SCREEN, 5000);
  assert.equal(cfg.gemini.model, 'gemini-flash-latest');
});
