import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterEq } from '../src/clients/nocodb.js';
import { escapeHtml, formatMoney, safeEqual, sanitizeFilename } from '../src/util.js';

test('sanitizeFilename strips paths and unusual chars', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('my ad!.png'), 'my_ad_.png');
  assert.equal(sanitizeFilename('C:\\Users\\me\\art.jpg'), 'art.jpg');
  assert.equal(sanitizeFilename(''), 'artwork');
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
});

test('formatMoney renders cents as dollars', () => {
  assert.equal(formatMoney(7500), '$75.00');
  assert.equal(formatMoney(4000), '$40.00');
  assert.equal(formatMoney(0), '$0.00');
});

test('escapeHtml escapes the five significant chars', () => {
  assert.equal(escapeHtml('<b>"a&b"</b>'), '&lt;b&gt;&quot;a&amp;b&quot;&lt;/b&gt;');
});

test('safeEqual compares constant-time by value', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('filterEq escapes NocoDB grammar characters', () => {
  assert.equal(filterEq('Ad_ID', 'abc-123'), '(Ad_ID,eq,abc-123)');
  // a value that tries to inject a second condition is neutralized
  const injected = filterEq('Ad_ID', 'x),(Status,eq,APPROVED');
  assert.equal(injected, '(Ad_ID,eq,x\\)\\,\\(Status\\,eq\\,APPROVED)');
});
