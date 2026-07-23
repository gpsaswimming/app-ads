// JSON-schema + cross-field validation for POST /api/submit (DESIGN.md §2, §5).
// additionalProperties:false — the body is a closed shape; unknown keys are rejected.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { AFFILIATIONS, CONTENT_TYPES, PLACEMENTS, PAYMENT_METHODS, TEAMS } from '../constants.js';

export function buildSubmitSchema(maxUploadBytes) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'submitter_name',
      'submitter_email',
      'submitter_is_advertiser',
      'company_name',
      'advertiser_name',
      'advertiser_email',
      'team',
      'ad_title',
      'placement',
      'payment_method',
      'rights_confirmed',
      'filename',
      'content_type',
      'byte_size',
      'turnstile_token',
    ],
    properties: {
      submitter_name: { type: 'string', minLength: 1, maxLength: 200 },
      submitter_email: { type: 'string', format: 'email', maxLength: 320 },
      submitter_phone: { type: 'string', maxLength: 40 },
      submitter_is_advertiser: { type: 'boolean' },
      company_name: { type: 'string', minLength: 1, maxLength: 200 },
      advertiser_name: { type: 'string', minLength: 1, maxLength: 200 },
      advertiser_email: { type: 'string', format: 'email', maxLength: 320 },
      advertiser_phone: { type: 'string', maxLength: 40 },
      team: { type: 'string', enum: AFFILIATIONS },
      ad_title: { type: 'string', minLength: 1, maxLength: 200 },
      placement: { type: 'string', enum: PLACEMENTS },
      payment_method: { type: 'string', enum: PAYMENT_METHODS },
      // Must be affirmatively true — an unchecked box cannot submit (DESIGN.md §3/§4).
      rights_confirmed: { const: true },
      filename: { type: 'string', minLength: 1, maxLength: 255 },
      content_type: { type: 'string', enum: CONTENT_TYPES },
      byte_size: { type: 'integer', minimum: 1, maximum: maxUploadBytes },
      turnstile_token: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  };
}

export function createSubmitValidator(maxUploadBytes) {
  const ajv = new Ajv({ allErrors: true, removeAdditional: false, coerceTypes: false });
  addFormats(ajv);
  const validate = ajv.compile(buildSubmitSchema(maxUploadBytes));
  return function validateSubmit(body) {
    const ok = validate(body);
    if (ok) return { ok: true, errors: [] };
    const errors = (validate.errors || []).map((e) => {
      const path = e.instancePath || '(root)';
      return `${path} ${e.message}`.trim();
    });
    return { ok: false, errors };
  };
}

const TEAM_SET = new Set(TEAMS);

/**
 * Cross-field rules that JSON-schema can't express (DESIGN.md §2):
 *  - payment method must match the affiliation (team ⇒ PAY_TEAM; GPSA ⇒ CHECK|SQUARE_INVOICE);
 *  - when "I am the advertiser", the advertiser_* fields must equal the submitter_* fields.
 * Returns null when valid, or a human-readable reason string.
 */
export function crossValidateSubmit(body) {
  const isTeam = TEAM_SET.has(body.team);

  if (isTeam) {
    if (body.payment_method !== 'PAY_TEAM') {
      return `payment_method must be PAY_TEAM when a team is the affiliation`;
    }
  } else {
    // team === 'GPSA' (schema already constrained the enum)
    if (body.payment_method !== 'CHECK' && body.payment_method !== 'SQUARE_INVOICE') {
      return `payment_method must be CHECK or SQUARE_INVOICE for a GPSA-level ad`;
    }
  }

  if (body.submitter_is_advertiser) {
    if (body.advertiser_name !== body.submitter_name) {
      return `advertiser_name must equal submitter_name when submitter_is_advertiser is true`;
    }
    if (body.advertiser_email !== body.submitter_email) {
      return `advertiser_email must equal submitter_email when submitter_is_advertiser is true`;
    }
    // Optional phone: if either is present they must match; both absent is fine.
    if ((body.advertiser_phone || '') !== (body.submitter_phone || '')) {
      return `advertiser_phone must equal submitter_phone when submitter_is_advertiser is true`;
    }
  }

  return null;
}
