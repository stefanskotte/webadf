import { readLha } from './lha';
import { readZip } from './zip';

/**
 * "Is this dropped file an archive, and if so what is in it?"
 *
 * Aminet distributes almost everything as .lha, and picking two files out of a
 * download is the ordinary case -- so an archive dropped onto a disk expands
 * into the staging area exactly as a dropped FOLDER does, and every rule that
 * already applies there (destination, collisions, renaming, the block-based
 * free-space estimate) applies unchanged.
 */

export interface ArchiveMember {
  /** '/'-separated, relative to the archive root. */
  path: string;
  bytes: Uint8Array;
  /** AmigaDOS protection bits, or null when the archive carried none.
   *  NOT defaulted to 0 here: "said nothing" and "said rwed" are different
   *  claims and only the first may be replaced downstream. */
  protection: number | null;
}

export interface ArchiveResult {
  format: 'lha' | 'zip';
  members: ArchiveMember[];
  /** Members the reader would not decode, with a reason, so a short file list
   *  is never silently short. */
  skipped: { path: string; reason: string }[];
}

/**
 * The cap protects the BROWSER, not the disk.
 *
 * Decoding happens in the tab, so a very large archive costs memory and time
 * there. It says nothing about whether the contents fit: an ADF holds 880 KB,
 * and what decides fit is the block-based estimate in staging -- built because
 * bytes lie about it, a hundred 1 KB files costing 300 blocks to hold 100 KB.
 * Conflating the two is how you get a "fits" that does not.
 */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export function isArchiveName(name: string): boolean {
  return /\.(lha|lzh|zip)$/i.test(name);
}

export type ArchiveError =
  | { error: 'too-large'; sizeBytes: number }
  | { error: 'unreadable' };

/**
 * Expand an archive. Returns null when the file is not one by name, so the
 * caller can treat it as an ordinary dropped file.
 *
 * Nested archives are deliberately NOT expanded: a .lha inside a .lha lands as
 * a file, which is what the operator asked for.
 */
export async function expandArchive(
  fileName: string, bytes: Uint8Array,
): Promise<ArchiveResult | ArchiveError | null> {
  if (!isArchiveName(fileName)) return null;
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    return { error: 'too-large', sizeBytes: bytes.length };
  }

  const zip = /\.zip$/i.test(fileName);
  try {
    if (zip) {
      const { entries, skipped } = await readZip(bytes);
      if (entries.length === 0 && skipped.length > 0 && skipped[0].reason === 'not a zip') {
        return { error: 'unreadable' };
      }
      return { format: 'zip', members: entries, skipped };
    }
    const { entries, skipped } = readLha(bytes);
    // An .lha that yields nothing at all is a file that is not really an
    // archive, or one in a method from before 1990. Either way the honest
    // answer is "could not read it" rather than an empty list that looks like
    // an empty archive.
    if (entries.length === 0 && skipped.length === 0) return { error: 'unreadable' };
    return { format: 'lha', members: entries, skipped };
  } catch {
    // Neither reader is supposed to throw, but this is a drop target: an
    // exception escaping here is a dead UI, so the guarantee is enforced at
    // the boundary too rather than merely intended.
    return { error: 'unreadable' };
  }
}
