// A5's bulk Download: the selected entries of a disk as one .zip, folders
// with everything under them. A zip has no place for AmigaDOS protection
// bits or comments, so those stay on the disk.

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { readFile, type AdfEntry } from '@/lib/adffs';
import { findEntry, underSelected } from '@/lib/disk-entries';

/** "a.txt" -> "a (2).txt"; "Startup" -> "Startup (2)". */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export type ZipOutcome =
  | { ok: true; zip: Uint8Array }
  /** `unreadable` names the file whose data could not be read. */
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'unreadable'; name: string };

/** "." and ".." are legal AmigaDOS names but mean something else in a zip path. */
const safe = (name: string) => (name === '.' || name === '..' ? `_${name}` : name);

/** Write `files` (a path ending in "/" is a folder) as one zip, in order. */
function writeZip(files: { path: string; bytes: Uint8Array | null }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, data) => { if (err) throw err; chunks.push(data); });
  for (const f of files) {
    const entry = f.bytes === null ? new ZipPassThrough(f.path) : new ZipDeflate(f.path, { level: 6 });
    zip.add(entry);
    entry.push(f.bytes ?? new Uint8Array(0), true);
  }
  zip.end();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Zip the entries at `blocks` (each at the top of the archive under its own
 * name; a folder brings its whole subtree). Refused, rather than a zip quietly
 * missing something, when a block is not an entry of `root` or a file cannot
 * be read.
 *
 * Paths are handed to the zip writer as strings, never used as object keys,
 * so a file called `__proto__` or `toString` is a file like any other. Two
 * selected entries from different folders can share a name, also differing
 * only in case (macOS and Windows would extract one over the other): the
 * later one is numbered.
 */
export function zipEntries(adf: Uint8Array, root: AdfEntry[], blocks: readonly number[]): ZipOutcome {
  const selected = new Set(blocks);
  const tops: AdfEntry[] = [];
  for (const b of selected) {
    const e = findEntry(root, b);
    if (!e) return { ok: false, reason: 'not_found' };
    if (!underSelected(root, b, selected)) tops.push(e);
  }
  // No limits, so never too_large.
  return zipTops(tops.map((entry) => ({ adf, entry }))) as ZipOutcome;
}

/** The Files manager's multi-file download caps (spec 2026-10-29 §3.3): entries counted with every folder. */
export type ZipLimits = { maxEntries: number; maxBytes: number };

/**
 * Entries, each from its own image (so a selection can span disks), each at the top of the archive under its own
 * name with its subtree below it -- the rules zipEntries describes. With `limits`, a selection over either cap is
 * refused before any file is read.
 */
export function zipTops(
  tops: readonly { adf: Uint8Array; entry: AdfEntry }[], limits?: ZipLimits,
): ZipOutcome | { ok: false; reason: 'too_large' } {
  if (limits) {
    let entries = 0; let bytes = 0;
    const count = (e: AdfEntry) => { entries++; if (e.kind === 'dir') e.children.forEach(count); else bytes += e.sizeBytes; };
    tops.forEach((t) => count(t.entry));
    if (entries > limits.maxEntries || bytes > limits.maxBytes) return { ok: false, reason: 'too_large' };
  }

  const files: { path: string; bytes: Uint8Array | null }[] = [];
  const add = (adf: Uint8Array, e: AdfEntry, path: string): string | null => {
    if (e.kind === 'dir') {
      files.push({ path: `${path}/`, bytes: null });
      for (const c of e.children) {
        const bad = add(adf, c, `${path}/${safe(c.name)}`);
        if (bad !== null) return bad;
      }
      return null;
    }
    const content = readFile(adf, e.block);
    if (!content) return e.name;
    files.push({ path, bytes: content.bytes });
    return null;
  };

  const taken = new Set<string>();
  for (const { adf, entry } of tops) {
    const base = safe(entry.name);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = numbered(base, n);
    taken.add(name.toLowerCase());
    const bad = add(adf, entry, name);
    if (bad !== null) return { ok: false, reason: 'unreadable', name: bad };
  }
  return { ok: true, zip: writeZip(files) };
}
