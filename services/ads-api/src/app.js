// Fastify app factory. Takes a fully-assembled dependency context so tests can inject
// fakes (Turnstile, NocoDB, MinIO, mailer, Gemini) and drive the handlers without any
// real network. server.js wires the production clients.

import Fastify from 'fastify';

import { makeAdminHandlers } from './handlers/admin.js';
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
  const admin = makeAdminHandlers(hctx);

  app.get('/health', async () => ({ status: 'ok', service: 'app-ads-api' }));
  app.post('/api/submit', submit);
  app.post('/internal/uploaded', uploaded);

  // /admin-api/* — internal dashboard backend. Never routed to the public edge (the DMZ
  // nginx 404s it); reached only from the app-ads-admin container on the VPN. No app auth
  // by design — the VPN boundary is the trust boundary (docs/TODO.md #1).
  app.get('/admin-api/ads', admin.list);
  app.get('/admin-api/ads/:adId/artwork', admin.artwork);
  app.post('/admin-api/ads/:adId/approve', admin.approve);
  app.post('/admin-api/ads/:adId/deny', admin.deny);

  return app;
}
