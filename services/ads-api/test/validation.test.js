import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSubmitValidator, crossValidateSubmit } from '../src/validation/submit-schema.js';
import { validSubmitBody } from './helpers.js';

const validate = createSubmitValidator(52428800);

test('accepts a well-formed body', () => {
  const res = validate(validSubmitBody());
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('rejects rights_confirmed !== true', () => {
  const res = validate(validSubmitBody({ rights_confirmed: false }));
  assert.equal(res.ok, false);
});

test('rejects unknown fields (additionalProperties:false)', () => {
  const res = validate(validSubmitBody({ sneaky: 'x' }));
  assert.equal(res.ok, false);
});

test('rejects an unknown team', () => {
  const res = validate(validSubmitBody({ team: 'Atlantis' }));
  assert.equal(res.ok, false);
});

test('rejects an oversize byte_size', () => {
  const res = validate(validSubmitBody({ byte_size: 52428801 }));
  assert.equal(res.ok, false);
});

test('rejects a bad content_type', () => {
  const res = validate(validSubmitBody({ content_type: 'image/gif' }));
  assert.equal(res.ok, false);
});

test('cross-field: team affiliation requires PAY_TEAM', () => {
  assert.equal(crossValidateSubmit(validSubmitBody()), null);
  const bad = crossValidateSubmit(validSubmitBody({ payment_method: 'CHECK' }));
  assert.match(bad, /PAY_TEAM/);
});

test('cross-field: GPSA affiliation requires CHECK or SQUARE_INVOICE', () => {
  const gpsaCheck = validSubmitBody({ team: 'GPSA', payment_method: 'CHECK' });
  assert.equal(crossValidateSubmit(gpsaCheck), null);
  const bad = crossValidateSubmit(validSubmitBody({ team: 'GPSA', payment_method: 'PAY_TEAM' }));
  assert.match(bad, /CHECK or SQUARE_INVOICE/);
});

test('cross-field: advertiser must mirror submitter when "I am the advertiser"', () => {
  const mismatch = validSubmitBody({ advertiser_email: 'someone-else@example.com' });
  assert.match(crossValidateSubmit(mismatch), /advertiser_email/);
});

test('cross-field: distinct advertiser allowed when not the advertiser', () => {
  const body = validSubmitBody({
    submitter_is_advertiser: false,
    advertiser_name: 'Jane Doe',
    advertiser_email: 'jane@pizza.com',
  });
  assert.equal(crossValidateSubmit(body), null);
});
