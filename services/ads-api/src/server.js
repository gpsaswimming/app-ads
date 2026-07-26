// Ads API entry point. Loads + validates config (fail fast), wires the real clients,
// and starts Fastify. The only credentialed component in the system (DESIGN.md §3).

import { buildApp } from './app.js';
import { createGeminiChecker } from './clients/gemini.js';
import { createMinioClients } from './clients/minio.js';
import { createNocoClient } from './clients/nocodb.js';
import { createTurnstileVerifier } from './clients/turnstile.js';
import { loadConfig } from './config.js';
import { createMailer } from './email/mailer.js';
import { validateDimensions } from './validation/dimensions.js';
import { createSubmitValidator } from './validation/submit-schema.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
}

const ctx = {
  config,
  verifyTurnstile: createTurnstileVerifier(config.turnstile),
  validateSubmit: createSubmitValidator(config.minio.maxUploadBytes),
  noco: createNocoClient(config.nocodb),
  minio: createMinioClients(config.minio),
  mailer: createMailer({
    smtpUrl: config.smtp.url,
    from: config.smtp.from,
    notifyEmail: config.smtp.notifyEmail,
    checkAddress: config.gpsaCheckAddress,
  }),
  checkAppropriateness: createGeminiChecker(config.gemini),
  validateDimensions,
};

const app = buildApp(ctx);

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
