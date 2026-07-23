// POST /internal/uploaded — the single async seam (DESIGN.md §2 step 5, §6).
// Fired by MinIO's ObjectCreated webhook. NOT publicly routable (§3 inv 8); the call
// carries MINIO_TO_API_SECRET. Ignores any key without `pending_` so the approved_
// rename doesn't re-trigger. Runs dimension check → Gemini → status + emails.

import { STATUS } from '../constants.js';
import { adIdFromKey } from '../clients/minio.js';
import { safeEqual } from '../util.js';

/** Pull the pending_ object keys out of a MinIO/S3 ObjectCreated event payload. */
export function extractPendingKeys(payload) {
  const records = Array.isArray(payload?.Records) ? payload.Records : [];
  const keys = [];
  for (const rec of records) {
    const name = rec?.eventName || '';
    if (!name.startsWith('s3:ObjectCreated')) continue;
    const rawKey = rec?.s3?.object?.key;
    if (!rawKey) continue;
    let key;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (!key.includes('pending_')) continue; // ignore approved_ (rename) + anything else
    keys.push({
      key,
      size: rec?.s3?.object?.size ?? null,
      contentType: rec?.s3?.object?.contentType || null,
    });
  }
  return keys;
}

/** Read the shared secret from either `Authorization: Bearer <t>` or a bare value. */
function authTokenFrom(headers) {
  const raw = headers?.authorization || '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

export function makeUploadedHandler(ctx) {
  const { config, log, noco, minio, mailer, validateDimensions, checkAppropriateness } = ctx;

  async function processObject({ key, size, contentType }) {
    const adId = adIdFromKey(key);
    const row = await noco.findByAdId(adId);
    if (!row) {
      log.warn({ adId, key }, 'uploaded event for unknown Ad_ID — ignoring');
      return;
    }

    const effectiveContentType = contentType || row.Content_Type;

    // Mark validating + record the artifact facts.
    await noco.updateAd(row.Id, {
      Status: STATUS.VALIDATING,
      Artwork_URI: `s3://${minio.bucket}/${key}`,
      Artwork_Bytes: size,
      Content_Type: effectiveContentType,
    });
    Object.assign(row, { Status: STATUS.VALIDATING, Artwork_Bytes: size, Content_Type: effectiveContentType });

    const buffer = await minio.getObjectBuffer(key);

    // Dimension check → hard REJECT on failure (§5).
    const dims = await validateDimensions(buffer, row.Placement, effectiveContentType);
    if (!dims.ok) {
      const update = {
        Status: STATUS.REJECTED,
        Artwork_Width: dims.width,
        Artwork_Height: dims.height,
        Validation_Notes: dims.reason,
      };
      await noco.updateAd(row.Id, update);
      Object.assign(row, update);
      await mailer.sendOutcome(row);
      await mailer.sendInternal(row);
      log.info({ adId, reason: dims.reason }, 'ad rejected on dimensions');
      return;
    }

    // Gemini appropriateness — advisory; ANY error/timeout → NEEDS_REVIEW (fail safe).
    let appropriate = false;
    let reason = 'Flagged for human review';
    let aiSummary = '';
    try {
      const verdict = await checkAppropriateness(buffer, effectiveContentType);
      appropriate = verdict.appropriate;
      reason = verdict.reason || reason;
      aiSummary = verdict.summary || '';
    } catch (err) {
      appropriate = false;
      reason = 'Appropriateness check unavailable — routed for human review';
      log.warn({ adId, err: err.message }, 'gemini check failed — routing to NEEDS_REVIEW');
    }

    if (appropriate) {
      const newKey = await minio.renameToApproved(key);
      const update = {
        Status: STATUS.APPROVED,
        Artwork_URI: `s3://${minio.bucket}/${newKey}`,
        Artwork_Width: dims.width,
        Artwork_Height: dims.height,
      };
      await noco.updateAd(row.Id, update);
      Object.assign(row, update);
      await mailer.sendOutcome(row);
      await mailer.sendInternal(row, { aiSummary });
      log.info({ adId }, 'ad approved');
      return;
    }

    const update = {
      Status: STATUS.NEEDS_REVIEW,
      Artwork_Width: dims.width,
      Artwork_Height: dims.height,
      Validation_Notes: reason,
    };
    await noco.updateAd(row.Id, update);
    Object.assign(row, update);
    await mailer.sendOutcome(row);
    await mailer.sendInternal(row, { aiSummary });
    log.info({ adId, reason }, 'ad routed to NEEDS_REVIEW');
  }

  return async function uploaded(request, reply) {
    // Shared-secret auth (constant-time). No token → 401, nothing processed.
    if (!safeEqual(authTokenFrom(request.headers), config.minio.webhookSecret)) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    const objects = extractPendingKeys(request.body);
    if (objects.length === 0) {
      return reply.code(200).send({ ignored: true });
    }

    // Volume is tiny (dozens/season); process sequentially and never let one failure
    // fail the webhook — MinIO would retry the whole batch otherwise.
    let processed = 0;
    for (const obj of objects) {
      try {
        await processObject(obj);
        processed += 1;
      } catch (err) {
        log.error({ key: obj.key, err: err.message }, 'failed to process uploaded object');
      }
    }
    return reply.code(200).send({ processed });
  };
}
