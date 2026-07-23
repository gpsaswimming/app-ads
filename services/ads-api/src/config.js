// Config loader — reads and validates every env var at boot and FAILS FAST if a
// required one is missing (DESIGN.md §7). The Ads API is the only credentialed
// component, so all secrets/config arrive here at runtime via ads-api.env — nothing
// is baked into the image.

// Required keys have no safe default: startup aborts if any is absent/blank.
const REQUIRED = [
  'MINIO_ENDPOINT_INTERNAL', // C — internal SDK host (renames)
  'MINIO_ENDPOINT_PUBLIC', // C — public presign-target host
  'MINIO_ACCESS_KEY', // S — scoped MinIO service account
  'MINIO_SECRET_KEY', // S
  'MINIO_TO_API_SECRET', // S — shared secret verifying the ObjectCreated webhook
  'NOCODB_URL', // C — database base URL
  'NOCODB_TOKEN', // S — database API token
  'NOCODB_BASE_ID', // C — provisioned base id
  'NOCODB_ADS_TABLE_ID', // C — provisioned Ads table id
  'TURNSTILE_SECRET', // S — server-side siteverify
  'GEMINI_API_KEY', // S — appropriateness check
  'SMTP_URL', // S — email transport (contains credentials)
  'ADS_NOTIFY_EMAIL', // C — internal "new submission" recipient
  'GPSA_CHECK_ADDRESS', // C — mailing address for the CHECK email
  'SUBMISSION_DEADLINE', // C — ISO datetime; form closes + API rejects after
];

function requireEmail(name, value, errors) {
  // deliberately loose — the SMTP relay is the real validator; this only catches typos.
  if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    errors.push(`${name} is not a valid email address: "${value}"`);
  }
}

/**
 * Build the frozen runtime config from an env bag (defaults to process.env).
 * Throws an Error listing every problem if anything required is missing/invalid.
 */
export function loadConfig(env = process.env) {
  const errors = [];

  for (const key of REQUIRED) {
    const v = env[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors.push(`Missing required env var: ${key}`);
    }
  }

  requireEmail('ADS_NOTIFY_EMAIL', env.ADS_NOTIFY_EMAIL, errors);

  const deadlineRaw = env.SUBMISSION_DEADLINE;
  const deadlineMs = deadlineRaw ? Date.parse(deadlineRaw) : NaN;
  if (deadlineRaw && Number.isNaN(deadlineMs)) {
    errors.push(`SUBMISSION_DEADLINE is not a parseable date: "${deadlineRaw}"`);
  }

  const num = (name, raw, def) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(`${name} must be a positive number, got "${raw}"`);
      return def;
    }
    return n;
  };

  const priceFull = num('PRICE_FULL_CENTS', env.PRICE_FULL_CENTS, 9000);
  const priceHalf = num('PRICE_HALF_CENTS', env.PRICE_HALF_CENTS, 5000);
  const maxUploadBytes = num('MAX_UPLOAD_BYTES', env.MAX_UPLOAD_BYTES, 52428800); // 50 MB
  const presignExpirySeconds = num('PRESIGN_EXPIRY_SECONDS', env.PRESIGN_EXPIRY_SECONDS, 900); // 15 min
  const port = num('PORT', env.PORT, 8080);
  const geminiTimeoutMs = num('GEMINI_TIMEOUT_MS', env.GEMINI_TIMEOUT_MS, 15000);
  const turnstileTimeoutMs = num('TURNSTILE_TIMEOUT_MS', env.TURNSTILE_TIMEOUT_MS, 10000);

  if (errors.length > 0) {
    throw new Error(
      `Invalid ads-api configuration:\n  - ${errors.join('\n  - ')}\n` +
        `See ads-api.env.example for every required key.`,
    );
  }

  return Object.freeze({
    port,
    host: env.HOST || '0.0.0.0',

    minio: Object.freeze({
      endpointInternal: env.MINIO_ENDPOINT_INTERNAL,
      endpointPublic: env.MINIO_ENDPOINT_PUBLIC,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET || 'gpsa-ads',
      webhookSecret: env.MINIO_TO_API_SECRET,
      presignExpirySeconds,
      maxUploadBytes,
    }),

    nocodb: Object.freeze({
      url: env.NOCODB_URL.replace(/\/+$/, ''),
      token: env.NOCODB_TOKEN,
      baseId: env.NOCODB_BASE_ID,
      tableId: env.NOCODB_ADS_TABLE_ID,
    }),

    turnstile: Object.freeze({
      secret: env.TURNSTILE_SECRET,
      timeoutMs: turnstileTimeoutMs,
    }),

    gemini: Object.freeze({
      apiKey: env.GEMINI_API_KEY,
      // Current Gemini Flash tier (DESIGN.md §5); config-overridable so the exact
      // model id can be confirmed/rotated at deploy without a code change.
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      timeoutMs: geminiTimeoutMs,
    }),

    smtp: Object.freeze({
      url: env.SMTP_URL,
      from: env.MAIL_FROM || 'GPSA Scoreboard Ads <no-reply@gpsaswimming.org>',
      notifyEmail: env.ADS_NOTIFY_EMAIL,
    }),

    meetName: env.MEET_NAME || '2026 City Meet',
    gpsaCheckAddress: env.GPSA_CHECK_ADDRESS,
    submissionDeadlineMs: deadlineMs,

    pricing: Object.freeze({
      FULL_SCREEN: priceFull,
      HALF_SCREEN: priceHalf,
    }),
  });
}
