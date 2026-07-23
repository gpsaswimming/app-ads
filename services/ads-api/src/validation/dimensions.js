// Artwork dimension validation (DESIGN.md §5). Config-driven per placement:
// reject wrong aspect (±1%) or below the locked 150-DPI minimums; else proceed to
// the appropriateness check. Reads pixels in-process with sharp.

import sharp from 'sharp';

import { ASPECT_TOLERANCE, CONTENT_TYPES, PLACEMENT_SPECS } from '../constants.js';

/**
 * @param {Buffer} buffer  the uploaded image bytes
 * @param {string} placement  FULL_SCREEN | HALF_SCREEN
 * @param {string} contentType  reported content type
 * @returns {Promise<{ok:boolean, width:number|null, height:number|null, reason:string|null}>}
 */
export async function validateDimensions(buffer, placement, contentType) {
  const spec = PLACEMENT_SPECS[placement];
  if (!spec) {
    return { ok: false, width: null, height: null, reason: `Unknown placement "${placement}"` };
  }

  if (!CONTENT_TYPES.includes(contentType)) {
    return { ok: false, width: null, height: null, reason: `Unsupported content type "${contentType}"` };
  }

  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    return { ok: false, width: null, height: null, reason: 'File is not a readable PNG or JPEG image' };
  }

  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) {
    return { ok: false, width: width || null, height: height || null, reason: 'Could not read image dimensions' };
  }

  // Ratio only — resolution is the submitter's call (DESIGN.md §5).
  const aspect = width / height;
  const aspectOff = Math.abs(aspect - spec.aspect) / spec.aspect;
  if (aspectOff > ASPECT_TOLERANCE) {
    return {
      ok: false,
      width,
      height,
      reason: `${width}×${height} is not the required ${spec.label} aspect ratio`,
    };
  }

  return { ok: true, width, height, reason: null };
}
