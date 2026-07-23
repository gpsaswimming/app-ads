import assert from 'node:assert/strict';
import { test } from 'node:test';

import sharp from 'sharp';

import { validateDimensions } from '../src/validation/dimensions.js';

function png(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 35, b: 102 } } })
    .png()
    .toBuffer();
}

test('accepts an exact 150-DPI full-screen image (2700×1200, 9:4)', async () => {
  const res = await validateDimensions(await png(2700, 1200), 'FULL_SCREEN', 'image/png');
  assert.equal(res.ok, true, res.reason || '');
  assert.equal(res.width, 2700);
  assert.equal(res.height, 1200);
});

test('accepts a larger 300-DPI full-screen image (5400×2400, 9:4)', async () => {
  const res = await validateDimensions(await png(5400, 2400), 'FULL_SCREEN', 'image/png');
  assert.equal(res.ok, true, res.reason || '');
});

test('accepts an exact half-screen image (1350×1200, 9:8)', async () => {
  const res = await validateDimensions(await png(1350, 1200), 'HALF_SCREEN', 'image/png');
  assert.equal(res.ok, true, res.reason || '');
});

test('rejects wrong aspect ratio', async () => {
  const res = await validateDimensions(await png(2000, 1200), 'FULL_SCREEN', 'image/png');
  assert.equal(res.ok, false);
  assert.match(res.reason, /aspect/);
});

test('accepts a low-res image at the right ratio (resolution not enforced)', async () => {
  // 900×400 = 9:4, and 864×768 = 9:8 (last year's half-screen size) — both accepted.
  const full = await validateDimensions(await png(900, 400), 'FULL_SCREEN', 'image/png');
  assert.equal(full.ok, true, full.reason || '');
  const half = await validateDimensions(await png(864, 768), 'HALF_SCREEN', 'image/png');
  assert.equal(half.ok, true, half.reason || '');
});

test('rejects an unsupported content type', async () => {
  const res = await validateDimensions(await png(2700, 1200), 'FULL_SCREEN', 'image/gif');
  assert.equal(res.ok, false);
});

test('rejects unreadable bytes', async () => {
  const res = await validateDimensions(Buffer.from('not an image'), 'FULL_SCREEN', 'image/png');
  assert.equal(res.ok, false);
});
