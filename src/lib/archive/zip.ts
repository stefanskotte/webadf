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
 * Zip carries no AmigaDOS protection bits -- nothing in the format has a place
 * for them -- so `protection` is always null here. That is not a gap to fill
 * later: inventing Amiga bits from a Unix mode does not translate, which is
 * the same call made for LHA's Unix extension headers.
 */

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** Always null: zip has nowhere to put AmigaDOS protection. */
  protection: null;
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

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
export async function readZip(buf: Uint8Array): Promise<ZipReadResult> {
  const entries: ZipEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];

  const eocd = findEocd(buf);
  if (eocd < 0) return { entries, skipped: [{ path: '(archive)', reason: 'not a zip' }] };

  const count = u16(buf, eocd + 10);
  let cen = u32(buf, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (cen + 46 > buf.length || u32(buf, cen) !== CEN_SIG) break;

    const flags = u16(buf, cen + 8);
    const method = u16(buf, cen + 10);
    const compSize = u32(buf, cen + 20);
    const nameLen = u16(buf, cen + 28);
    const extraLen = u16(buf, cen + 30);
    const commentLen = u16(buf, cen + 32);
    const localAt = u32(buf, cen + 42);
    const path = name(buf.subarray(cen + 46, cen + 46 + nameLen), (flags & 0x800) !== 0);
    cen += 46 + nameLen + extraLen + commentLen;

    // A trailing '/' is how zip records a directory; it has no data, and the
    // staging area builds parents from the paths of real files.
    if (path.endsWith('/')) continue;

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
        entries.push({ path, bytes: raw.slice(), protection: null, method: 'stored' });
      } else if (method === 8) {
        entries.push({ path, bytes: await inflateRaw(raw), protection: null, method: 'deflate' });
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
