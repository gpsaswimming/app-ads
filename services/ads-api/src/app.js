// Fastify app factory. Takes a fully-assembled dependency context so tests can inject
// fakes (Turnstile, NocoDB, MinIO, mailer, Gemini) and drive the handlers without any
// real network. server.js wires the production clients.

import Fastify from 'fastify';

import { makeSubmitHandler } from './handlers/submit.js';
import { makeUploadedHandler } from './handlers/uploaded.js';

export function buildApp(ctx, opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // No file ever transits the API — metadata only — so keep the body small.
    bodyLimit: opts.bodyLimit ?? 262144, // 256 KB
    ...opts.fastify,
  });

  const hctx = { ...ctx, log: app.log };
  const submit = makeSubmitHandler(hctx);
  const uploaded = makeUploadedHandler(hctx);

  app.get('/health', async () => ({ status: 'ok', service: 'app-ads-api' }));
  app.post('/api/submit', submit);
  app.post('/internal/uploaded', uploaded);

  return app;
}
