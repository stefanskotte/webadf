/**
 * Zip reading, with no dependency.
 *
 * The container is a handful of fixed-layout records, and the only compression
 * worth supporting -- deflate -- is built into the platform as
 * DecompressionStream('deflate-raw'). Pulling in a zip library to avoid
 * ~150 lines would ship a decompressor the browser already has.
 *
 * Read from the CENTRAL DIRECTORY, not by scanning local file headers. A local
 * header may carry zeroed sizes with the real values in a trailing data
 * descriptor (that is what the streaming bit-3 flag means), so walking local
 * headers is how a reader ends up guessing where members end. The central
 * directory always has the truth.
 *
 * Zip has no AmigaDOS protection field of its own, so `protection` is null
 * except for a member made on an Amiga (R11, below). Inventing Amiga bits from
 * a Unix mode does not translate, which is the same call made for LHA's Unix
 * extension headers.
 */

import { readBounded } from './bounded';
import { dosDateTime } from './dos-date';

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** AmigaDOS protection bits for a member made on an Amiga, else null. */
  protection: number | null;
  /** The Unix time ('UT' extra field, UTC) when present, else the DOS stamp read
   *  as a wall clock (R10); null when neither is a valid date. */
  date: Date | null;
  method: string;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  skipped: { path: string; reason: string }[];
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Zip stores names as UTF-8 when flag bit 11 is set, CP437 otherwise. Latin-1
 *  is a close enough stand-in for CP437's printable range, and the staging
 *  area masks names to what AmigaDOS accepts regardless. */
function name(b: Uint8Array, utf8: boolean): string {
  return new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(b).replace(/\\/g, '/');
}

/** The 'UT' extra field (0x5455): flags byte, then a u32 Unix mtime when bit 0 is set. */
function utTime(extra: Uint8Array): Date | null {
  for (let p = 0; p + 4 <= extra.length;) {
    const id = u16(extra, p), size = u16(extra, p + 2);
    if (id === 0x5455 && size >= 5 && p + 4 + size <= extra.length && (extra[p + 4] & 1)) {
      return new Date(u32(extra, p + 5) * 1000);
    }
    p += 4 + size;
  }
  return null;
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  return readBounded(stream, maxBytes);
}

export interface ZipReadOptions {
  /** Only members whose path this accepts are decompressed; the rest are
   *  skipped with reason 'not selected'. Default: every member. */
  accept?: (path: string) => boolean;
  /** Largest decompressed member; a bigger one is skipped as 'too large'
   *  rather than inflated whole (a deflate bomb). Default: unbounded. */
  maxEntryBytes?: number;
  /** Largest sum of decompressed output, counting the output a refused member
   *  produced before it was refused; once reached, further members are skipped
   *  as 'archive limit reached' (many small bombs, or one bomb named many
   *  times). Default: unbounded. */
  maxTotalBytes?: number;
}

/** Find the end-of-central-directory record, scanning back over any comment. */
function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read a zip. Never throws: like readLha, the caller is a drop target, where
 * an exception is a dead UI with no explanation.
 */
export async function readZip(buf: Uint8Array, opts: ZipReadOptions = {}): Promise<ZipReadResult> {
  const maxEntry = opts.maxEntryBytes ?? Number.MAX_SAFE_INTEGER;
  const maxTotal = opts.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
  let total = 0;
  const entries: ZipEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];

  const eocd = findEocd(buf);
  if (eocd < 0) return { entries, skipped: [{ path: '(archive)', reason: 'not a zip' }] };

  const count = u16(buf, eocd + 10);
  let cen = u32(buf, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (cen + 46 > buf.length || u32(buf, cen) !== CEN_SIG) break;

    const madeBy = buf[cen + 5];
    const flags = u16(buf, cen + 8);
    const method = u16(buf, cen + 10);
    const compSize = u32(buf, cen + 20);
    const nameLen = u16(buf, cen + 28);
    const extraLen = u16(buf, cen + 30);
    const commentLen = u16(buf, cen + 32);
    const dosStamp = ((u16(buf, cen + 14) << 16) | u16(buf, cen + 12)) >>> 0;
    const external = u32(buf, cen + 38);
    const localAt = u32(buf, cen + 42);
    const extra = buf.subarray(cen + 46 + nameLen, cen + 46 + nameLen + extraLen);
    const path = name(buf.subarray(cen + 46, cen + 46 + nameLen), (flags & 0x800) !== 0);
    cen += 46 + nameLen + extraLen + commentLen;
    const date = utTime(extra) ?? dosDateTime(dosStamp);
    // R11: Info-ZIP's Amiga port (host byte 1) keeps the AmigaDOS protection
    // word in the high 16 bits of the external attributes. UNVERIFIED against a
    // real Amiga-made zip: only a synthetic fixture exercises this so far.
    const protection = madeBy === 1 ? (external >>> 16) & 0xff : null;

    // A trailing '/' is how zip records a directory; it has no data, and the
    // staging area builds parents from the paths of real files.
    if (path.endsWith('/')) continue;

    if (opts.accept && !opts.accept(path)) {
      skipped.push({ path, reason: 'not selected' });
      continue;
    }

    if ((flags & 0x1) !== 0) {
      skipped.push({ path, reason: 'encrypted' });
      continue;
    }

    // The local header's own name/extra lengths are authoritative for where
    // its data starts, and they can differ from the central directory's.
    if (localAt + 30 > buf.length) { skipped.push({ path, reason: 'bad offset' }); continue; }
    const dataAt = localAt + 30 + u16(buf, localAt + 26) + u16(buf, localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);

    try {
      if (method === 0) {
        if (raw.length > maxEntry) skipped.push({ path, reason: 'too large' });
        else if (total + raw.length > maxTotal) skipped.push({ path, reason: 'archive limit reached' });
        else {
          total += raw.length;
          entries.push({ path, bytes: raw.slice(), protection, date, method: 'stored' });
        }
      } else if (method === 8) {
        // The remaining total is the bound too, so one member cannot overshoot it.
        const bound = Math.min(maxEntry, maxTotal - total);
        if (bound <= 0) { skipped.push({ path, reason: 'archive limit reached' }); continue; }
        const out = await inflateRaw(raw, bound);
        if (out) {
          total += out.length;
          entries.push({ path, bytes: out, protection, date, method: 'deflate' });
        } else {
          // The inflate ran to the bound before giving up: charge that work, or
          // one bomb named by 65,535 entries is re-inflated 65,535 times.
          total += bound;
          skipped.push({ path, reason: bound < maxEntry ? 'archive limit reached' : 'too large' });
        }
      } else {
        // bzip2, lzma, zstd and friends. Rare in this corner of the world and
        // named rather than silently dropped.
        skipped.push({ path, reason: `unsupported zip method ${method}` });
      }
    } catch {
      skipped.push({ path, reason: 'could not decompress' });
    }
  }

  return { entries, skipped };
}
