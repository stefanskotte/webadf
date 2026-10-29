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

/**
 * One entry name as ONE safe zip path component. AmigaDOS itself refuses ':' and '/', but a crafted image can hold
 * any bytes in a header (bcplString maps only control characters), so a name like "../../x" or "a\\b" must not
 * become a path that climbs out of the folder it is extracted into (zip-slip). '/', '\\', ':' and control
 * characters become '_'; an empty name, "." and ".." become "_", "_." and "_.." (the last two as before). Ordinary
 * names are unchanged.
 */
export function safe(name: string): string {
  const s = name.replace(/[/\\:\u0000-\u001f\u007f]/g, '_');
  return s === '' ? '_' : s === '.' || s === '..' ? `_${s}` : s;
}

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

/** What `entry` puts in a zip: every entry under it, counted with the folders, and its files' bytes. Reads nothing. */
export function tallyTop(entry: AdfEntry): { entries: number; bytes: number } {
  let entries = 0; let bytes = 0;
  const count = (e: AdfEntry) => { entries++; if (e.kind === 'dir') e.children.forEach(count); else bytes += e.sizeBytes; };
  count(entry);
  return { entries, bytes };
}

/** One top entry read out of its image, so the image can be let go: its files as paths below its (not yet chosen) name. */
export type ReadTop = { name: string; files: { rel: string; bytes: Uint8Array | null }[] };

/** Read `entry` (a folder with everything under it) out of `adf`; `unreadable` names the first file that cannot be read. */
export function readTop(adf: Uint8Array, entry: AdfEntry): ReadTop | { unreadable: string } {
  const files: ReadTop['files'] = [];
  const add = (e: AdfEntry, rel: string): string | null => {
    if (e.kind === 'dir') {
      files.push({ rel: `${rel}/`, bytes: null });
      for (const c of e.children) {
        const bad = add(c, `${rel}/${safe(c.name)}`);
        if (bad !== null) return bad;
      }
      return null;
    }
    const content = readFile(adf, e.block);
    if (!content) return e.name;
    files.push({ rel, bytes: content.bytes });
    return null;
  };
  const bad = add(entry, '');
  return bad === null ? { name: entry.name, files } : { unreadable: bad };
}

/** Tops already read, in order, as one zip: each under its own name, a later one sharing a name numbered. */
export function zipReadTops(tops: readonly ReadTop[]): Uint8Array {
  const files: { path: string; bytes: Uint8Array | null }[] = [];
  const taken = new Set<string>();
  for (const t of tops) {
    const base = safe(t.name);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = numbered(base, n);
    taken.add(name.toLowerCase());
    for (const f of t.files) files.push({ path: name + f.rel, bytes: f.bytes });
  }
  return writeZip(files);
}

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
    for (const t of tops) { const n = tallyTop(t.entry); entries += n.entries; bytes += n.bytes; }
    if (entries > limits.maxEntries || bytes > limits.maxBytes) return { ok: false, reason: 'too_large' };
  }
  const read: ReadTop[] = [];
  for (const { adf, entry } of tops) {
    const r = readTop(adf, entry);
    if ('unreadable' in r) return { ok: false, reason: 'unreadable', name: r.unreadable };
    read.push(r);
  }
  return { ok: true, zip: zipReadTops(read) };
}

/** One top as a device's `collect` walks it (src/lib/files/driver.ts IncomingItem): rel[0] is the top's own name. */
export type ZipIncomingTop = { items: readonly { rel: string[]; kind: 'file' | 'dir'; bytes?: Uint8Array; size?: number }[] };

/** What `tops` put in a zip, counted as tallyTop counts: every entry with the folders, and the files' bytes. Reads nothing. */
export function tallyIncoming(tops: readonly ZipIncomingTop[]): { entries: number; bytes: number } {
  let entries = 0; let bytes = 0;
  for (const t of tops) for (const i of t.items) { entries++; if (i.kind === 'file') bytes += i.bytes?.length ?? i.size ?? 0; }
  return { entries, bytes };
}

/**
 * Entries from any device (each top as its driver's `collect` gave it, with its files' bytes), as one zip by the rules
 * zipTops follows: each top under its own name, a later one sharing a name numbered, every name through `safe`. Over
 * either cap is refused before anything is written; a file that came without its bytes is `unreadable`.
 */
export function zipIncoming(tops: readonly ZipIncomingTop[], limits: ZipLimits): ZipOutcome | { ok: false; reason: 'too_large' } {
  const n = tallyIncoming(tops);
  if (n.entries > limits.maxEntries || n.bytes > limits.maxBytes) return { ok: false, reason: 'too_large' };
  const read: ReadTop[] = [];
  for (const t of tops) {
    if (!t.items.length) return { ok: false, reason: 'not_found' };
    const files: ReadTop['files'] = [];
    for (const i of t.items) {
      const rel = i.rel.slice(1).map((s) => `/${safe(s)}`).join('');
      if (i.kind === 'dir') { files.push({ rel: `${rel}/`, bytes: null }); continue; }
      if (!i.bytes) return { ok: false, reason: 'unreadable', name: i.rel[i.rel.length - 1] };
      files.push({ rel, bytes: i.bytes });
    }
    read.push({ name: t.items[0].rel[0], files });
  }
  return { ok: true, zip: zipReadTops(read) };
}
