// Fastify app factory. Takes a fully-assembled dependency context so tests can inject
// fakes (Turnstile, NocoDB, MinIO, mailer, Gemini) and drive the handlers without any
// real network. server.js wires the production clients.

import Fastify from 'fastify';

import { makeAdminHandlers } from './handlers/admin.js';
import { makeSubmitHandler } from './handlers/submit.js';
import { makeTeamHandlers } from './handlers/team.js';
import { makeUploadedHandler } from './handlers/uploaded.js';

export function buildApp(ctx, opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // No file ever transits the API — metadata only — so keep the body small.
    bodyLimit: opts.bodyLimit ?? 262144, // 256 KB
    ...opts.fastify,
  });

  // Tolerate an empty body on JSON POSTs. A no-payload action like approve legitimately
  // POSTs with `Content-Type: application/json` and no body; Fastify's default parser
  // rejects that with FST_ERR_CTP_EMPTY_JSON_BODY (400). Treat empty as "no body"; keep
  // strict parsing (400) for malformed non-empty JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body == null) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  const hctx = { ...ctx, log: app.log };
  const submit = makeSubmitHandler(hctx);
  const uploaded = makeUploadedHandler(hctx);
  const admin = makeAdminHandlers(hctx);
  const team = makeTeamHandlers(hctx);

  app.get('/health', async () => ({ status: 'ok', service: 'app-ads-api' }));
  app.post('/api/submit', submit);
  app.post('/internal/uploaded', uploaded);

  // /admin-api/* — internal dashboard backend. Never routed to the public edge (the DMZ
  // nginx 404s it); reached only from the app-ads-admin container on the VPN. No app auth
  // by design — the VPN boundary is the trust boundary (docs/TODO.md #1).
  app.get('/admin-api/ads', admin.list);
  app.get('/admin-api/treasurer.pdf', admin.treasurerPdf);
  app.get('/admin-api/ads/:adId/artwork', admin.artwork);
  app.post('/admin-api/ads/:adId/approve', admin.approve);
  app.post('/admin-api/ads/:adId/deny', admin.deny);
  app.post('/admin-api/ads/:adId/payment', admin.setPayment);

  // /api/team/* — the team-facing ad status list (§12). Read-only, no app auth (like
  // /admin-api/*); served on the separate team-ads origin. The public form front 404s this
  // path so it's reached only through the team origin. Artwork bytes are streamed through
  // the API (bucket stays private).
  app.get('/api/team/ads', team.ads);
  app.get('/api/team/ads/:adId/artwork', team.artwork);

  return app;
}
