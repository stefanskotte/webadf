import { decodeLzh } from './lzh-decode';

/**
 * LHA/LZH container reading: headers at levels 0, 1 and 2, and the methods an
 * Aminet archive actually uses.
 *
 * Level matters and cannot be assumed. macOS's `lha` writes LEVEL 2 by
 * default; archives made on a real Amiga -- which is most of Aminet -- are
 * level 0 or 1. All three are here, with a fixture apiece produced by the
 * reference tool.
 *
 * NESTED ARCHIVES ARE OUT OF SCOPE by the operator's decision, as are file
 * comments. Amiga protection bits are IN scope and are the reason the
 * extended-header walk below exists at all.
 */

/** LHA stores path separators as 0xff, not '/'. */
const LHA_SEP = 0xff;

export interface LhaEntry {
  /** '/'-separated, already translated from LHA's 0xff separator. */
  path: string;
  bytes: Uint8Array;
  /** AmigaDOS protection bits as stored in a file header block at offset 320,
   *  or null when the archive carries none (anything not written by an Amiga). */
  protection: number | null;
  method: string;
}

export interface LhaReadResult {
  entries: LhaEntry[];
  /** Entries the archive contained that this reader would not decode, with the
   *  reason. Surfaced rather than dropped: a silently short file list is how
   *  somebody ends up with half an archive and no idea why. */
  skipped: { path: string; reason: string }[];
}

const td = new TextDecoder('latin1');

function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function toPath(raw: Uint8Array): string {
  // A NUL ENDS THE NAME. Level 0/1 headers pack the file comment into the same
  // field as "name\0comment", so l2boot.lha on Aminet yields a path of
  // "l2remote.boot\0created 02.08.2026 00:38:42, last accessed..." if this is
  // not done -- bytes decoded perfectly, filename unusable. Comments are out of
  // scope by the operator's decision, so the tail is simply dropped.
  const nul = raw.indexOf(0);
  const name = nul === -1 ? raw : raw.subarray(0, nul);
  let s = '';
  for (const ch of name) s += ch === LHA_SEP ? '/' : String.fromCharCode(ch);
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Walk the extended-header chain for the two things worth having: the real
 * filename/directory, and the Amiga permission word.
 *
 * THE SIZE OF EACH HEADER IS STORED AT THE END OF THE PREVIOUS ONE, not at its
 * own start -- the base header's last two bytes give the first extension's
 * size, and every extension's last two bytes give the next one's. Reading a
 * size at the start of each header instead decodes level 0 and 2 correctly by
 * luck (neither derives its data offset from this walk) and silently lands
 * level 1's payload 26 bytes early, which produces files of exactly the right
 * LENGTH full of the wrong bytes. Verified against `lha x`.
 *
 * Header 0x40 is the DOS/Amiga attribute extension; on Amiga-written archives
 * its first two bytes are the AmigaDOS protection mask -- the same layout an
 * ADF file header block holds at offset 320, so it carries straight through.
 */
function readExtended(
  buf: Uint8Array, firstSizeAt: number, headersAt: number,
): { dir: string; name: string; protection: number | null; end: number } {
  let dir = '';
  let name = '';
  let protection: number | null = null;

  if (firstSizeAt + 2 > buf.length) return { dir, name, protection, end: headersAt };
  let size = u16(buf, firstSizeAt);
  let pos = headersAt;

  // Bounded by the buffer, and by refusing a size too small to contain its own
  // type and trailing length: a corrupt archive must not spin here.
  while (size >= 3 && pos + size - 2 + 2 <= buf.length) {
    const type = buf[pos];
    const bodyEnd = pos + size - 2;
    const body = buf.subarray(pos + 1, bodyEnd);

    if (type === 0x01) name = toPath(body);
    else if (type === 0x02) dir = toPath(body);
    else if (type === 0x40 && body.length >= 2) protection = u16(body, 0);

    const next = u16(buf, bodyEnd);
    pos = bodyEnd + 2;
    if (next === 0) break;
    size = next;
  }
  return { dir, name, protection, end: pos };
}

/** Methods this reader decodes, and the window size each one uses. */
const DIC_BITS: Record<string, number> = { '-lh5-': 13, '-lh6-': 15, '-lh7-': 16 };

/**
 * Read an LHA archive. Never throws on malformed input -- a bad archive
 * returns what it could read plus a `skipped` reason, because the caller is a
 * drop target and an exception there is a dead UI with no explanation.
 */
export function readLha(buf: Uint8Array): LhaReadResult {
  const entries: LhaEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let off = 0;

  while (off + 21 < buf.length) {
    const level = buf[off + 20];
    const method = td.decode(buf.subarray(off + 2, off + 7));
    if (!method.startsWith('-lh') && !method.startsWith('-lz')) break;

    let packed = u32(buf, off + 7);
    const original = u32(buf, off + 11);
    let dataStart: number;
    let path = '';
    let protection: number | null = null;

    if (level === 0 || level === 1) {
      const headerSize = buf[off];
      if (headerSize === 0) break;
      const nameLen = buf[off + 21];
      path = toPath(buf.subarray(off + 22, off + 22 + nameLen));
      // Level 0 ends at header_size; level 1 continues into extended headers
      // whose sizes are counted in `packed`, not in the base header.
      const baseEnd = off + headerSize + 2;
      if (level === 0) {
        dataStart = baseEnd;
      } else {
        // The first extension's size lives in the base header's last two bytes.
        const ext = readExtended(buf, baseEnd - 2, baseEnd);
        protection = ext.protection;
        // The DIRECTORY comes from extension 0x02; the NAME stays whatever the
        // base header said unless extension 0x01 overrides it. Replacing the
        // whole path with ext.dir + ext.name drops the filename entirely when
        // only the directory extension is present, which is the common case.
        path = ext.dir + (ext.name || path);
        dataStart = ext.end;
        // Level 1's "packed size" counts the extended headers too, so the
        // actual compressed payload is what is left after them.
        packed -= ext.end - baseEnd;
      }
    } else if (level === 2) {
      const headerSize = u16(buf, off);
      if (headerSize === 0) break;
      // Level 2 states the first extension's size at offset 24, with the
      // headers themselves starting right after it.
      const ext = readExtended(buf, off + 24, off + 26);
      protection = ext.protection;
      path = ext.dir + ext.name;
      dataStart = off + headerSize;
    } else {
      skipped.push({ path: `(header level ${level})`, reason: 'unsupported-header-level' });
      break;
    }

    const data = buf.subarray(dataStart, dataStart + Math.max(0, packed));

    if (method === '-lhd-') {
      // A directory entry. Carries no data, and the staging area creates
      // parents implicitly from entry paths, so there is nothing to emit.
    } else if (method === '-lh0-' || method === '-lz4-') {
      entries.push({ path, bytes: data.slice(0, original), protection, method });
    } else if (DIC_BITS[method] !== undefined) {
      const outBytes = decodeLzh(data, original, DIC_BITS[method]);
      if (outBytes.length !== original) {
        skipped.push({ path, reason: `truncated (${outBytes.length}/${original} bytes)` });
      } else {
        entries.push({ path, bytes: outBytes, protection, method });
      }
    } else {
      // -lh1-, -lh2-, -lh3- and the -lz- family are pre-1990 and essentially
      // absent from Aminet. Named rather than silently dropped.
      skipped.push({ path, reason: `unsupported method ${method}` });
    }

    const next = dataStart + Math.max(0, packed);
    if (next <= off) break;   // no forward progress: refuse to loop
    off = next;
  }

  return { entries, skipped };
}
