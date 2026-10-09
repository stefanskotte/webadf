// Upload from a URL: fetch (src/lib/url-fetch.ts), recognise, store, register.
//
// After the fetch this is the browser upload, done by the server:
//   browser: hash -> /check -> presigned PUT -> /complete
//   here:    hash -> blobs lookup -> diskStore.put -> registerUploads()
// registerUploads() IS /complete's code (src/lib/ingest-complete.ts), so
// verification, dedupe, HFE inspection, entitlements, grouping and the TOSEC
// sweep are one code path whichever way the bytes arrived. The format
// handling is the dropzone's too: toAdf() for .adf/.adz/.dms, inspectHfe()
// for .hfe, isUploadableSize() for the size limit.
//
// What a URL adds, and the browser path does not need: the bytes are not
// trusted to be what the URL or the server's Content-Type says. They are
// sniffed (zip / gzip / DMS / HFE signatures, or exactly an ADF's size), and
// anything else -- an HTML error page, most often -- is refused.

import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { registerUploads } from '@/lib/ingest-complete';
import { toAdf, DISK_IMAGE_PATTERN, MAX_COMPRESSED_IMAGE_BYTES } from '@/lib/archive/disk-image';
import { readZip } from '@/lib/archive/zip';
import { inspectHfe, describeInspection } from '@/lib/hfe/inspect';
import { adfDensity, isHfeFilename } from '@/lib/disk-format';
import { isUploadableSize, describeUnuploadableSize } from '@/lib/blob-upload';
import { fetchUrlSafely, type UrlFetchCode, type UrlFetchResult } from '@/lib/url-fetch';

/** Disk images taken from one URL (a .zip of a release). Well inside
 *  MAX_HFE_PER_BATCH and the 60 s route budget. */
export const MAX_IMAGES_PER_URL = 20;

export type UrlIngestCode =
  | UrlFetchCode
  | 'not_a_disk_image'
  | 'no_disk_images'
  | 'too_many_images'
  | 'unsupported_archive'
  | 'store_busy'
  | 'ingest_failed';

export type UrlIngestRow = {
  filename: string;
  sizeBytes: number;
  /** null for a file refused before it was hashed. */
  sha256: string | null;
  state: 'deduped' | 'done' | 'failed';
  note?: string;
};

export type UrlIngestResult =
  | { ok: true; rows: UrlIngestRow[] }
  | { ok: false; code: UrlIngestCode; status?: number };

// ---------------------------------------------------------------- naming

const MAX_NAME = 200;

/** A plain file name: no path, no control characters, bounded. '' if nothing usable. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
}

/** The name the server offered (Content-Disposition), else the URL's last path segment. */
export function nameFromResponse(finalUrl: URL, contentDisposition: string | null): string {
  if (contentDisposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(contentDisposition);
    if (star) {
      try {
        const n = cleanName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
        if (n) return n;
      } catch { /* malformed escape: fall through */ }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(contentDisposition);
    if (plain) {
      const n = cleanName((plain[2] ?? plain[1]).trim());
      if (n) return n;
    }
  }
  const last = finalUrl.pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep it encoded */ }
  return cleanName(decoded) || 'download';
}

/** `name` with its extension replaced by `ext` (a known image/archive suffix is dropped first). */
function withExt(name: string, ext: string): string {
  const stem = name
    .replace(/\.gz$/i, '')
    .replace(/\.(adf|dsk|adz|dms|hfe|zip|bin|img|php|cgi|aspx?|html?)$/i, '');
  return `${stem || 'download'}.${ext}`;
}

// ---------------------------------------------------------------- sniffing

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  return sig.every((v, i) => b[at + i] === v);
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export type Sniffed = 'zip' | 'gzip' | 'dms' | 'hfe' | 'adf' | 'lha' | 'other-archive' | 'unknown';

/** What the bytes are, by signature or (for a bare ADF, which has none) by exact size. */
export function sniff(b: Uint8Array): Sniffed {
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(b, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(b, ascii('DMS!'))) return 'dms';
  if (startsWith(b, ascii('HXCPICFE')) || startsWith(b, ascii('HXCHFEV3'))) return 'hfe';
  if (b.length > 7 && b[2] === 0x2d && b[3] === 0x6c && (b[4] === 0x68 || b[4] === 0x7a) && b[6] === 0x2d) return 'lha';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(b, ascii('Rar!')) || startsWith(b, ascii('BZh'))) {
    return 'other-archive';
  }
  if (adfDensity(b.length) !== null) return 'adf';
  return 'unknown';
}

// ---------------------------------------------------------------- images

type Image = { filename: string; bytes: Uint8Array; note?: string };
type Prepared = { images: Image[]; refused: UrlIngestRow[] };

/**
 * One named file, exactly as the dropzone handles it (dropzone.tsx's
 * handleFiles): an .hfe is inspected and stored as it is, everything else
 * goes through toAdf(). Then the one URL-only rule: an ADF must be exactly a
 * DD or HD disk -- the plausibility check a browser user does not need,
 * because they chose the file.
 */
async function prepareOne(name: string, bytes: Uint8Array): Promise<Image | UrlIngestRow> {
  const fail = (note: string): UrlIngestRow => ({ filename: name, sizeBytes: bytes.length, sha256: null, state: 'failed', note });
  if (isHfeFilename(name)) {
    const r = inspectHfe(bytes);
    if (!r.ok) return fail(r.reason);
    if (!isUploadableSize(bytes.length)) return fail(describeUnuploadableSize(name, bytes.length));
    return { filename: name, bytes, note: describeInspection(r) };
  }
  const conv = await toAdf(name, bytes);
  if (!conv.ok) return fail(conv.reason);
  if (adfDensity(conv.bytes.length) === null) return fail(`${conv.name} is not the size of an Amiga disk`);
  return {
    filename: conv.name, bytes: conv.bytes,
    note: conv.from === 'adf' ? undefined : `from ${name}${conv.note ? ` (${conv.note})` : ''}`,
  };
}

/** Turn the fetched bytes into disk images, or say why not. */
export async function prepareImages(
  bytes: Uint8Array, offeredName: string,
): Promise<Prepared | { code: UrlIngestCode }> {
  const kind = sniff(bytes);
  const single = async (name: string): Promise<Prepared> => {
    const r = await prepareOne(name, bytes);
    return 'bytes' in r ? { images: [r], refused: [] } : { images: [], refused: [r] };
  };

  switch (kind) {
    case 'adf': return single(withExt(offeredName, 'adf'));
    case 'dms': return single(withExt(offeredName, 'dms'));
    case 'hfe': return single(withExt(offeredName, 'hfe'));
    case 'gzip': {
      if (bytes.length > MAX_COMPRESSED_IMAGE_BYTES) return { code: 'not_a_disk_image' };
      // A gzipped ADF is an .adz. toAdf's gunzip is bounded at the disk limit,
      // and prepareOne refuses anything that does not come out ADF-sized.
      const r = await single(withExt(offeredName, 'adz'));
      return r.images.length === 0 ? { code: 'not_a_disk_image' } : r;
    }
    case 'zip': {
      let selected = 0;
      const { entries, skipped } = await readZip(bytes, {
        // Members are taken by their own names, as a dropped folder would be.
        // Counted here so members past the cap are never even decompressed.
        accept: (p) => !p.startsWith('__MACOSX/') && DISK_IMAGE_PATTERN.test(p) && ++selected <= MAX_IMAGES_PER_URL,
        maxEntryBytes: MAX_COMPRESSED_IMAGE_BYTES,
      });
      if (selected > MAX_IMAGES_PER_URL) return { code: 'too_many_images' };
      const out: Prepared = { images: [], refused: [] };
      for (const e of entries) {
        const r = await prepareOne(cleanName(e.path) || 'disk.adf', e.bytes);
        if ('bytes' in r) out.images.push(r); else out.refused.push(r);
      }
      for (const s of skipped) {
        if (s.reason === 'not selected' || !DISK_IMAGE_PATTERN.test(s.path)) continue;
        out.refused.push({ filename: cleanName(s.path), sizeBytes: 0, sha256: null, state: 'failed', note: s.reason });
      }
      if (out.images.length === 0 && out.refused.length === 0) return { code: 'no_disk_images' };
      return out;
    }
    case 'lha':
    case 'other-archive':
      return { code: 'unsupported_archive' };
    default:
      return { code: 'not_a_disk_image' };
  }
}

// ---------------------------------------------------------------- ingest

export interface UrlIngestDeps {
  fetch: (url: string) => Promise<UrlFetchResult>;
}

const defaultDeps: UrlIngestDeps = { fetch: (u) => fetchUrlSafely(u) };

/**
 * Fetch `url` and ingest what it holds into `orgId`'s library. `orgId` must
 * come from the session. Never throws for anything the URL or its content
 * does; a store or database failure still throws, as in /complete.
 */
export async function ingestFromUrl(
  orgId: string, url: string, deps: UrlIngestDeps = defaultDeps,
): Promise<UrlIngestResult> {
  const fetched = await deps.fetch(url);
  if (!fetched.ok) return { ok: false, code: fetched.code, ...(fetched.status ? { status: fetched.status } : {}) };

  const prepared = await prepareImages(fetched.bytes, nameFromResponse(fetched.finalUrl, fetched.contentDisposition));
  if ('code' in prepared) return { ok: false, code: prepared.code };

  // Hashed here, as the browser hashes before /check. One entry per content:
  // a zip holding the same disk twice registers it once.
  const bySha = new Map<string, Image & { sha256: string }>();
  for (const img of prepared.images) {
    const sha256 = contentHashes(img.bytes).sha256;
    if (!bySha.has(sha256)) bySha.set(sha256, { ...img, sha256 });
  }
  const rows: UrlIngestRow[] = [...prepared.refused];
  if (bySha.size === 0) return { ok: true, rows };

  // /check's question, asked directly: which of these does the store already hold?
  const shas = [...bySha.keys()];
  const known = new Set((await getDb().select({ sha256: blobs.sha256 }).from(blobs)
    .where(inArray(blobs.sha256, shas))).map((r) => r.sha256));

  // The presigned PUT's job, done in-process. diskStore.put treats "already
  // exists" as success, exactly as the browser path does (classifyUpload).
  const stored: string[] = [];
  for (const sha of shas) {
    if (known.has(sha)) { stored.push(sha); continue; }
    try {
      await diskStore.put(sha, bySha.get(sha)!.bytes);
      stored.push(sha);
    } catch (err) {
      console.error('url-ingest: store put failed', err);
      const img = bySha.get(sha)!;
      rows.push({ filename: img.filename, sizeBytes: img.bytes.length, sha256: sha, state: 'failed', note: 'could not be stored; try again' });
    }
  }
  if (stored.length === 0) return { ok: false, code: 'store_busy' };

  const res = await registerUploads(orgId, stored.map((sha) => {
    const img = bySha.get(sha)!;
    return { sha256: sha, sizeBytes: img.bytes.length, filename: img.filename };
  }));
  if (res.status === 503) return { ok: false, code: 'store_busy' };
  if (res.status !== 200 && res.status !== 409) return { ok: false, code: 'ingest_failed' };
  const body = (await res.json()) as { rejectedReasons?: Record<string, string> };
  const refusedBy = body.rejectedReasons ?? {};

  for (const sha of stored) {
    const img = bySha.get(sha)!;
    const base = { filename: img.filename, sizeBytes: img.bytes.length, sha256: sha };
    if (refusedBy[sha]) rows.push({ ...base, state: 'failed', note: refusedBy[sha] });
    else rows.push({ ...base, state: known.has(sha) ? 'deduped' : 'done', ...(img.note ? { note: img.note } : {}) });
  }
  return { ok: true, rows };
}
