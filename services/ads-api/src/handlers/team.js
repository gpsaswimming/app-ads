// /api/team/* — the team-facing ad view (DESIGN.md §12). Read-only, metadata only:
// it never touches object storage and never returns payment data or submitter PII beyond
// the advertiser name. Served on the dedicated team-ads origin, behind the edge's email
// auth.
//
// Trust model (DESIGN.md §3 inv 13): the edge authenticates the viewer and injects a
// verified identity header (client-supplied copies stripped). This handler trusts that
// header, resolves the caller's authorized affiliations from the Reps allowlist, and
// validates EVERY requested scope against that set — a caller may ask for any affiliation
// but only receives data for ones they are authorized for.

import { STATUS } from '../constants.js';

// Statuses a team may see. Transient in-flight states (AWAITING_UPLOAD / UPLOADED /
// VALIDATING) are hidden — they resolve within seconds and would only confuse. REJECTED is
// hidden unless the caller opts in via ?include_rejected=true.
const DEFAULT_VISIBLE = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW]);
const WITH_REJECTED = new Set([STATUS.APPROVED, STATUS.NEEDS_REVIEW, STATUS.REJECTED]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Project a NocoDB Ads row to the minimal, safe shape the team view renders. */
function toTeamAd(row) {
  const isRejected = row.Status === STATUS.REJECTED;
  return {
    ad_title: row.Ad_Title || '',
    advertiser: row.Company_Name || row.Advertiser_Name || '',
    placement: row.Placement || null,
    submitted_at: row.CreatedAt ?? null,
    status: row.Status || null,
    // Reason is only meaningful for — and only ever exposed on — rejected ads.
    reason: isRejected ? (row.Validation_Notes || '') : '',
  };
}

export function makeTeamHandlers(ctx) {
  const { log, noco, reps, config } = ctx;
  // Header the edge injects (lowercased — Fastify lowercases header keys). Defensive
  // default keeps handler construction safe even if a test builds a config without `team`.
  const identityHeader = (config && config.team && config.team.identityHeader) || 'x-forwarded-email';

  // The authenticated email the edge injected, or null if absent/malformed.
  function callerEmail(request) {
    const raw = request.headers[identityHeader];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const email = String(value || '').trim().toLowerCase();
    return email && EMAIL_RE.test(email) ? email : null;
  }

  // 503 when the feature isn't provisioned (no Reps table id) so the core API still boots
  // and serves the submission platform without the team view configured.
  function ensureConfigured(reply) {
    if (!reps) {
      reply.code(503).send({ error: 'TEAM_VIEW_UNAVAILABLE' });
      return false;
    }
    return true;
  }

  /** GET /api/team/scopes — the affiliations the caller may view (drives the switcher). */
  async function scopes(request, reply) {
    if (!ensureConfigured(reply)) return;
    const email = callerEmail(request);
    if (!email) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });

    const affiliations = await reps.findAffiliationsByEmail(email);
    return reply.send({ email, affiliations });
  }

  /** GET /api/team/ads?team=<affiliation>[&include_rejected=true] — that affiliation's ads. */
  async function ads(request, reply) {
    if (!ensureConfigured(reply)) return;
    const email = callerEmail(request);
    if (!email) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });

    const team = String(request.query?.team || '').trim();
    if (!team) return reply.code(400).send({ error: 'TEAM_REQUIRED' });

    // Authorization: the requested scope MUST be in the caller's allowlist (inv 13).
    const allowed = await reps.findAffiliationsByEmail(email);
    if (!allowed.includes(team)) {
      log.info({ email, team }, 'team view: unauthorized affiliation requested');
      return reply.code(403).send({ error: 'FORBIDDEN' });
    }

    const includeRejected = request.query?.include_rejected === 'true';
    const visible = includeRejected ? WITH_REJECTED : DEFAULT_VISIBLE;

    const rows = await noco.listByTeam(team);
    const list = rows.filter((r) => visible.has(r.Status)).map(toTeamAd);
    return reply.send({ team, ads: list });
  }

  return { scopes, ads };
}
