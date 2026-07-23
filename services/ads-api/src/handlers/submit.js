// POST /api/submit — the synchronous hot path (DESIGN.md §2 step 3).
// Order is deliberate and load-bearing (§3): deadline FIRST (a stale page can't sneak
// a late submission past), then Turnstile (nothing is created without a valid token),
// then schema + cross-field validation, then the NocoDB row, then the presigned POST.

import { randomUUID } from 'node:crypto';

import { STATUS } from '../constants.js';
import { sanitizeFilename } from '../util.js';
import { crossValidateSubmit } from '../validation/submit-schema.js';

export function makeSubmitHandler(ctx) {
  const { config, log, verifyTurnstile, validateSubmit, noco, minio } = ctx;

  return async function submit(request, reply) {
    // 1. Deadline — checked before anything else.
    if (Date.now() > config.submissionDeadlineMs) {
      return reply.code(403).send({ error: 'SUBMISSIONS_CLOSED' });
    }

    const body = request.body || {};

    // 2. Turnstile — verified server-side before creating anything.
    const passed = await verifyTurnstile(body.turnstile_token, request.ip);
    if (!passed) {
      return reply.code(403).send({ error: 'TURNSTILE_FAILED' });
    }

    // 3. Schema (closed shape, rights_confirmed===true, enums, size cap).
    const schema = validateSubmit(body);
    if (!schema.ok) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', details: schema.errors });
    }

    // 4. Cross-field (payment method vs affiliation; advertiser mirror).
    const crossErr = crossValidateSubmit(body);
    if (crossErr) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', details: [crossErr] });
    }

    // 5. Create the row. Ad_ID is server-generated and becomes the object-key prefix.
    const adId = randomUUID();
    const filename = sanitizeFilename(body.filename);
    const amount = config.pricing[body.placement];

    const row = {
      Ad_ID: adId,
      Meet: config.meetName,
      Submitter_Name: body.submitter_name,
      Submitter_Email: body.submitter_email,
      Submitter_Phone: body.submitter_phone || '',
      Submitter_Is_Advertiser: body.submitter_is_advertiser,
      Company_Name: body.company_name,
      Advertiser_Name: body.advertiser_name,
      Advertiser_Email: body.advertiser_email,
      Advertiser_Phone: body.advertiser_phone || '',
      Team: body.team,
      Ad_Title: body.ad_title,
      Placement: body.placement,
      Status: STATUS.AWAITING_UPLOAD,
      Artwork_Filename: filename,
      Content_Type: body.content_type,
      Rights_Confirmed: true,
      Rights_Confirmed_At: new Date().toISOString(),
      Payment_Method: body.payment_method,
      Payment_Amount: amount,
      Payment_Status: 'PENDING',
    };

    await noco.createAd(row);

    // 6. Presigned POST — storage-enforced size/type gate, signed for the public host.
    const presign = await minio.presignUpload(adId, filename, body.content_type);

    log.info({ adId, placement: body.placement, team: body.team }, 'ad submission accepted');
    return reply.code(200).send({ ad_id: adId, presign });
  };
}
