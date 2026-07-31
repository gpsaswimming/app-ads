// Meet-prep artwork export (docs/TODO.md #1) — every APPROVED ad's artwork in one ZIP, so
// the meet director builds the scoreboard deck from a single download instead of running
// the `export-approved.sh` CLI against MinIO on the LAN.
//
// Entries are foldered by placement and numbered, so unzipping hands you the full-screen
// set and the half-screen set already in deck order, each file named for its advertiser.
//
// The ZIP is written here by hand rather than with an archiver dependency: the payloads are
// PNG/JPEG — already compressed — so every entry is STORED (no deflate) and the container
// is just the three header records below. Keeping the sole credentialed component's
// dependency surface small is worth more than a general-purpose archiver. Not zip64: a
// single ad is capped at MAX_UPLOAD_BYTES (50 MB) and a season is dozens of ads, so the
// format's 4 GB fields have plenty of headroom.

import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

import { keyFromUri } from '../clients/minio.js';
import { STATUS } from '../constants.js';

// Full-screen first: those are the whole-slide ads, and the deck is built around them.
const FOLDERS = [
  ['FULL_SCREEN', 'full-screen'],
  ['HALF_SCREEN', 'half-screen'],
];

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Lowercase, hyphenated, filesystem-safe fragment of a name. */
function slug(text, fallback) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** Extension for the stored object: content type first, then whatever the key carries. */
function extension(row, key) {
  const fromType = EXTENSIONS[row.Content_Type];
  if (fromType) return fromType;
  const fromKey = /\.([a-z0-9]{1,5})$/i.exec(key);
  return fromKey ? fromKey[1].toLowerCase() : 'img';
}

/**
 * Which objects go in the export, in which order, under which names.
 *
 * APPROVED ads only — the deck shows what was cleared for the scoreboard — and only those
 * with artwork actually in the bucket. Ordering is by placement, then advertiser, so a
 * re-export after a late approval reshuffles as little as possible.
 */
export function planArtworkExport(rows, bucket) {
  const entries = [];

  for (const [placement, folder] of FOLDERS) {
    const ads = rows
      .filter((row) => row.Status === STATUS.APPROVED && row.Placement === placement)
      .map((row) => ({ row, key: keyFromUri(row.Artwork_URI, bucket) }))
      .filter(({ key }) => Boolean(key))
      .sort((a, b) => String(a.row.Company_Name || '').localeCompare(String(b.row.Company_Name || ''))
        || String(a.row.Ad_ID).localeCompare(String(b.row.Ad_ID)));

    ads.forEach(({ row, key }, i) => {
      const n = String(i + 1).padStart(2, '0');
      entries.push({
        ad_id: row.Ad_ID,
        key,
        name: `${folder}/${n}_${slug(row.Company_Name, row.Ad_ID)}.${extension(row, key)}`,
      });
    });
  }

  return entries;
}

/** Suggested download name, e.g. `gpsa-ads-2026-city-meet-2026-07-30.zip`. */
export function artworkZipFilename(meetName, now = new Date()) {
  return `gpsa-ads-${slug(meetName, 'city-meet')}-${now.toISOString().slice(0, 10)}.zip`;
}

// ---- minimal STORED-entry ZIP writer -------------------------------------------------

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20; // 2.0 — all we use
const UTF8_NAMES = 0x0800; // general-purpose bit 11
const STORED = 0;

/** MS-DOS packed time/date, the only timestamp the base format carries. */
function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function localHeader({ nameBuf, crc, size, stamp }) {
  const h = Buffer.alloc(30 + nameBuf.length);
  h.writeUInt32LE(LOCAL_SIG, 0);
  h.writeUInt16LE(VERSION, 4);
  h.writeUInt16LE(UTF8_NAMES, 6);
  h.writeUInt16LE(STORED, 8);
  h.writeUInt16LE(stamp.time, 10);
  h.writeUInt16LE(stamp.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18); // compressed == uncompressed when stored
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28); // no extra field
  nameBuf.copy(h, 30);
  return h;
}

function centralHeader({ nameBuf, crc, size, stamp, offset }) {
  const c = Buffer.alloc(46 + nameBuf.length);
  c.writeUInt32LE(CENTRAL_SIG, 0);
  c.writeUInt16LE(VERSION, 4); // version made by
  c.writeUInt16LE(VERSION, 6); // version needed
  c.writeUInt16LE(UTF8_NAMES, 8);
  c.writeUInt16LE(STORED, 10);
  c.writeUInt16LE(stamp.time, 12);
  c.writeUInt16LE(stamp.date, 14);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(size, 20);
  c.writeUInt32LE(size, 24);
  c.writeUInt16LE(nameBuf.length, 28);
  c.writeUInt16LE(0, 30); // extra length
  c.writeUInt16LE(0, 32); // comment length
  c.writeUInt16LE(0, 34); // disk number
  c.writeUInt16LE(0, 36); // internal attributes
  c.writeUInt32LE(0, 38); // external attributes
  c.writeUInt32LE(offset, 42);
  nameBuf.copy(c, 46);
  return c;
}

function endOfCentralDirectory(count, size, offset) {
  const e = Buffer.alloc(22);
  e.writeUInt32LE(EOCD_SIG, 0);
  e.writeUInt16LE(0, 4); // this disk
  e.writeUInt16LE(0, 6); // disk with the central directory
  e.writeUInt16LE(count, 8);
  e.writeUInt16LE(count, 10);
  e.writeUInt32LE(size, 12);
  e.writeUInt32LE(offset, 16);
  e.writeUInt16LE(0, 20); // no archive comment
  return e;
}

/**
 * Stream a ZIP of the planned entries, fetching one object at a time so only a single
 * image is ever resident. `getObjectBuffer(key)` returns the bytes.
 *
 * A fetch that fails mid-archive destroys the stream: the download breaks loudly (a
 * truncated ZIP the browser and `unzip` both reject) rather than quietly handing the meet
 * director a deck with an ad missing from it.
 */
export function createArtworkZip(entries, getObjectBuffer, { now = new Date() } = {}) {
  const stamp = dosStamp(now);

  return Readable.from((async function* write() {
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const data = await getObjectBuffer(entry.key);
      const record = { nameBuf: Buffer.from(entry.name, 'utf8'), crc: crc32(data), size: data.length, stamp };
      const header = localHeader(record);
      yield header;
      yield data;
      central.push(centralHeader({ ...record, offset }));
      offset += header.length + data.length;
    }

    let directorySize = 0;
    for (const record of central) {
      directorySize += record.length;
      yield record;
    }
    yield endOfCentralDirectory(central.length, directorySize, offset);
  })());
}
