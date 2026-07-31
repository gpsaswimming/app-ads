import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  artworkZipFilename,
  createArtworkZip,
  planArtworkExport,
} from '../src/reports/artwork-export.js';

const BUCKET = 'gpsa-ads';

function ad(overrides = {}) {
  const adId = overrides.Ad_ID || 'ad-1';
  return {
    Ad_ID: adId,
    Status: 'APPROVED',
    Placement: 'FULL_SCREEN',
    Company_Name: "Joe's Pizza",
    Content_Type: 'image/png',
    Artwork_URI: `s3://${BUCKET}/${adId}/approved_art.png`,
    ...overrides,
  };
}

/** Read the archive back: every entry name, its stored bytes, and the EOCD entry count. */
function readZip(buf) {
  const entries = [];
  let offset = 0;
  while (buf.readUInt32LE(offset) === 0x04034b50) {
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const start = offset + 30 + nameLen + extraLen;
    entries.push({ name, data: buf.subarray(start, start + size), crc: buf.readUInt32LE(offset + 14) });
    offset = start + size;
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return { entries, eocdCount: buf.readUInt16LE(eocd + 10), directoryOffset: buf.readUInt32LE(eocd + 16) };
}

async function zipToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('plan includes only approved ads that have artwork in the bucket', () => {
  const rows = [
    ad({ Ad_ID: 'a', Company_Name: 'Approved Co' }),
    ad({ Ad_ID: 'b', Company_Name: 'Rejected Co', Status: 'REJECTED' }),
    ad({ Ad_ID: 'c', Company_Name: 'Reviewing Co', Status: 'NEEDS_REVIEW' }),
    ad({ Ad_ID: 'd', Company_Name: 'No Upload Co', Artwork_URI: null }),
  ];

  const entries = planArtworkExport(rows, BUCKET);
  assert.deepEqual(entries.map((e) => e.ad_id), ['a']);
  assert.equal(entries[0].key, 'a/approved_art.png');
});

test('plan folders by placement, numbers within each, and names for the advertiser', () => {
  const rows = [
    ad({ Ad_ID: 'a', Company_Name: 'Zeta Dental' }),
    ad({ Ad_ID: 'b', Company_Name: 'Acme Insurance' }),
    ad({
      Ad_ID: 'c',
      Company_Name: "Bob's Bait & Tackle",
      Placement: 'HALF_SCREEN',
      Content_Type: 'image/jpeg',
      Artwork_URI: `s3://${BUCKET}/c/approved_art.jpg`,
    }),
  ];

  assert.deepEqual(planArtworkExport(rows, BUCKET).map((e) => e.name), [
    'full-screen/01_acme-insurance.png',
    'full-screen/02_zeta-dental.png',
    'half-screen/01_bob-s-bait-tackle.jpg',
  ]);
});

test('plan falls back to the Ad_ID and the key extension when fields are thin', () => {
  const rows = [ad({ Ad_ID: 'ad-42', Company_Name: '', Content_Type: null, Artwork_URI: `s3://${BUCKET}/ad-42/approved_art.JPEG` })];
  assert.equal(planArtworkExport(rows, BUCKET)[0].name, 'full-screen/01_ad-42.jpeg');
});

test('the zip carries each entry byte-for-byte and a matching central directory', async () => {
  const entries = [
    { ad_id: 'a', key: 'a/approved_art.png', name: 'full-screen/01_acme.png' },
    { ad_id: 'b', key: 'b/approved_art.jpg', name: 'half-screen/01_bob.jpg' },
  ];
  const objects = {
    'a/approved_art.png': Buffer.from('PNG-bytes-for-acme'),
    'b/approved_art.jpg': Buffer.alloc(5000, 7), // a chunkier one
  };

  const buf = await zipToBuffer(createArtworkZip(entries, async (key) => objects[key]));
  const { entries: read, eocdCount, directoryOffset } = readZip(buf);

  assert.deepEqual(read.map((e) => e.name), ['full-screen/01_acme.png', 'half-screen/01_bob.jpg']);
  assert.deepEqual(read[0].data, objects['a/approved_art.png']);
  assert.deepEqual(read[1].data, objects['b/approved_art.jpg']);
  assert.equal(eocdCount, 2);
  // The central directory starts exactly where the last entry's data ended.
  assert.equal(buf.readUInt32LE(directoryOffset), 0x02014b50);
});

test('a fetch failure destroys the stream rather than emitting a short archive', async () => {
  const entries = [{ ad_id: 'a', key: 'a/gone.png', name: 'full-screen/01_acme.png' }];
  const zip = createArtworkZip(entries, async () => { throw new Error('object missing'); });
  await assert.rejects(zipToBuffer(zip), /object missing/);
});

test('the download name carries the meet and the date', () => {
  const name = artworkZipFilename('2026 City Meet', new Date('2026-07-30T12:00:00Z'));
  assert.equal(name, 'gpsa-ads-2026-city-meet-2026-07-30.zip');
});
