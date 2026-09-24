import { readDms } from './dms';

/**
 * Turn whatever the user dropped into a plain ADF.
 *
 * The library stores one thing: a 901,120-byte ADF. `setDesired` refuses to
 * mount anything else (src/lib/mount.ts), and the MFM encoder only knows that
 * shape -- so a compressed image has to become an ADF somewhere, and the
 * honest place is BEFORE the content hash is taken. Converting at upload means
 * the stored blob, its sha256, its TOSEC identity and every disk that
 * deduplicates against it are all the same for a .dms and for the .adf someone
 * else uploaded of the same disk. Converting later, on the way to a device,
 * would give the same disk two identities depending on how it arrived.
 *
 * This ran as dead UI until now: the dropzone has accepted .adz and .dms by
 * filename since it was written, nothing converted them, and the raw bytes
 * were stored as a "disk" that could never be mounted -- visible in the
 * library, refused at mount time, with nothing said about why.
 *
 * An .hfe is the exception: it is stored as uploaded (HFE spec D1), because
 * converting it to an ADF would discard exactly the flux a copy-protected
 * disk needs. It never reaches toAdf; the dropzone validates it with
 * inspectHfe instead.
 */

export const DISK_IMAGE_EXTENSIONS = ['adf', 'dsk', 'adz', 'dms', 'hfe'] as const;
export const DISK_IMAGE_PATTERN = /\.(adf|dsk|adz|dms|hfe)$/i;
/** A compressed image can expand to far more than it occupies; this bounds
 *  what a single dropped file may cost the tab, in the same spirit as
 *  MAX_ARCHIVE_BYTES next door. An ADF is 880 KB, so this is generous. */
export const MAX_COMPRESSED_IMAGE_BYTES = 4 * 1024 * 1024;

export type DiskImageResult =
  | { ok: true; bytes: Uint8Array; name: string; from: 'adf' | 'adz' | 'dms'; note?: string }
  | { ok: false; reason: string };

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Same approach as the .zip reader: the platform's own decompressor, so
  // there is no dependency and nothing to keep patched.
  const src = bytes.slice();
  const stream = new Blob([src.buffer as ArrayBuffer]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Replace a compressed extension with .adf, keeping the rest of the name --
 *  TOSEC matching reads the stem, so the name must survive the conversion. */
export function adfName(name: string): string {
  return name.replace(/\.(adz|dms)$/i, '.adf');
}

export async function toAdf(name: string, bytes: Uint8Array): Promise<DiskImageResult> {
  const ext = (name.match(DISK_IMAGE_PATTERN)?.[1] ?? '').toLowerCase();

  if (ext === 'adf' || ext === 'dsk') return { ok: true, bytes, name, from: 'adf' };

  if (bytes.length > MAX_COMPRESSED_IMAGE_BYTES) {
    return { ok: false, reason: `${name} is too large to expand in the browser` };
  }

  if (ext === 'adz') {
    // .adz is simply a gzipped .adf -- no container, no metadata.
    try {
      const out = await gunzip(bytes);
      return { ok: true, bytes: out, name: adfName(name), from: 'adz' };
    } catch {
      return { ok: false, reason: `${name} is not a valid gzipped ADF` };
    }
  }

  if (ext === 'dms') {
    try {
      const r = readDms(bytes);
      if (!r.ok) return { ok: false, reason: `${name}: ${r.reason}` };
      return {
        ok: true, bytes: r.adf, name: adfName(name), from: 'dms',
        note: r.info.modes.join('+'),
      };
    } catch {
      // readDms is written not to throw, but this is a drop target: an
      // exception escaping here is a dead UI, so the guarantee is enforced at
      // the boundary as well as intended in the decoder.
      return { ok: false, reason: `${name} could not be decoded` };
    }
  }

  return { ok: false, reason: `${name} is not a disk image` };
}
