// Small pure helpers shared across the Ads API.

import { timingSafeEqual } from 'node:crypto';

/**
 * Sanitize a user-supplied filename before it is appended to a server-built object
 * key (DESIGN.md §3 invariant 7). Strips any path, keeps a conservative charset, and
 * guarantees a non-empty, bounded result. The Ad_ID UUID — not this — is what makes
 * the key unique; this only keeps the stored name safe and readable.
 */
export function sanitizeFilename(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() // drop any directory component
    .trim();
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_') // collapse anything unusual to underscore
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, ''); // no leading dot/underscore (no hidden files)
  const bounded = cleaned.slice(0, 128);
  return bounded || 'artwork';
}

/** Constant-time string comparison that never throws on length/None mismatch. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Format integer cents as a plain dollar string, e.g. 7500 → "$75.00". */
export function formatMoney(cents) {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

/** Escape the five HTML-significant characters for any raw text rendered in email/HTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Read a stream fully into a Buffer (used for MinIO getObject). */
export function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
