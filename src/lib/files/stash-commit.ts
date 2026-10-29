// src/lib/files/stash-commit.ts
// A browser drop into STASH: (Files spec 2026-10-29 §4.2, R6): the files are already in the blob store by presigned PUT
// (POST /api/files/stash/presign); this verifies each one's size and sha-256 on the server, cleans the names by the
// Amiga's rules (R3) and writes the rows through the STASH: driver, source 'browser'. SERVER ONLY.
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { cleanAmigaPath } from '@/lib/transfers';
import { releaseRefused } from '@/lib/ingest-complete';
import { storeSendBytes } from '@/lib/send-http';
import { mapLimit } from '@/lib/pool';
import { STASH_COMMIT_MAX_BYTES, STASH_COMMIT_MAX_ENTRIES, STASH_FILE_MAX } from './stash-paths';
import { writeStash } from './stash-driver';
import { groupBy, refuse, Refused, type IncomingItem, type IncomingTop, type OnClash, type OpCtx, type OpItem } from './driver';
import type { FsPath } from './path';
import type { OpResult } from './ops';

/** One dropped entry, as the browser saw it: `path` relative to the folder dropped into, '/'-separated. */
export type CommitEntry = { path: string; kind: 'file' | 'dir'; sha256?: string; sizeBytes: number; lastModified?: number };

const NOT_WHOLE = 'upload did not arrive whole';

/** Each segment by the Amiga upload's own cleaner; null when one cleans to nothing (refused per file, bad_name). */
function cleanPath(path: string): string[] | null {
  const out: string[] = [];
  for (const seg of path.split('/').filter(Boolean)) {
    const c = cleanAmigaPath(seg);
    if (c === null || c.includes('/')) return null;
    out.push(c);
  }
  return out.length ? out : null;
}

/**
 * The size of the bytes at `sha256` when they are whole, checked as /api/ingest/complete verifies: they are hashed
 * before any size claimed is compared (over 20 MB they are never read). Bytes that do not hash to their key are forged
 * or broken: they are deleted unless something else names that key (ruling 2), so a poisoned adf/<sha> never makes
 * presign skip it for good. Bytes that do hash to it but are not the size claimed are authentic and kept; only the
 * claim is refused. Null: not held whole (only a blob the store does not have is "did not arrive"); any other storage
 * error propagates. One call per sha-256, so two claims on one key never race a release against a read.
 */
async function wholeSize(sha256: string): Promise<number | null> {
  const stat = await diskStore.stat(sha256);
  if (!stat) return null;
  // Never read more than a STASH: file may hold, whatever size was claimed: over it is no browser drop's, and it is
  // released by the same reference check (a blob something else names is kept).
  if (stat.sizeBytes > STASH_FILE_MAX) {
    await releaseRefused([sha256]);
    return null;
  }
  const bytes = await diskStore.read(sha256);
  if (contentHashes(bytes).sha256 !== sha256) {
    await releaseRefused([sha256]);
    return null;
  }
  return bytes.byteLength;
}

/**
 * A drop's entries into the STASH: folder `dir`, grouped into tops by their first segment, each top written whole or
 * refused whole (one item per top, its source the top's name as the browser sent it). Over 64 MB or 200 entries the
 * whole commit is refused (the client splits a drop by top-level item). `renamed`: every entry whose name was cleaned,
 * and every top stored under a keep-both name.
 */
export async function commitToStash(ctx: OpCtx, dir: FsPath, entries: CommitEntry[], onClash: OnClash)
  : Promise<OpResult & { renamed?: { from: string; to: string }[] }> {
  try {
    const bytes = entries.reduce((a, e) => a + (e.kind === 'file' ? e.sizeBytes : 0), 0);
    if (bytes > STASH_COMMIT_MAX_BYTES || entries.length > STASH_COMMIT_MAX_ENTRIES) {
      refuse('too_large', 413, `${STASH_COMMIT_MAX_BYTES / (1024 * 1024)} MB at a time`);
    }
    const renamedIn = new Map<string, { from: string; to: string }[]>();   // by top, reported only for a top stored
    const results = new Map<string, OpItem>();
    const order: string[] = [];
    type Cleaned = { e: CommitEntry; rel: string[] | null };
    const cleaned: Cleaned[] = entries.map((e) => ({ e, rel: cleanPath(e.path) }));
    const byTop = groupBy(cleaned, (c) => (c.rel?.[0] ?? c.e.path.split('/').filter(Boolean)[0] ?? c.e.path).toLowerCase());
    // Every blob checked before any top is planned, up to 12 at a time (a 60 s function); nothing is written until
    // writeStash, after all of them, so a top is still stored whole or not at all.
    const files = cleaned.filter((c) => c.rel && c.e.kind === 'file');
    const shas = [...new Set(files.flatMap((c) => (c.e.sizeBytes > 0 && c.e.sha256 ? [c.e.sha256] : [])))];
    const sizes = await mapLimit(shas, 12, wholeSize);
    const held = new Map(shas.map((sha, k) => [sha, sizes[k]] as const));
    const whole = (sha: string, size: number) => held.get(sha) === size;
    const emptySha = files.some((c) => c.e.sizeBytes === 0) ? await storeSendBytes(new Uint8Array(0)) : null;
    const tops: IncomingTop[] = [];
    for (const group of byTop.values()) {
      const source = group[0].e.path.split('/').filter(Boolean)[0] ?? group[0].e.path;
      order.push(source);
      try {
        const items: IncomingItem[] = [];
        const seen = new Set<string>();
        const renamed: { from: string; to: string }[] = [];
        const keys = group.flatMap((c) => (c.rel ? [c.rel.join('/').toLowerCase()] : []));
        for (const { e, rel } of group) {
          if (!rel) refuse('bad_name', 400, e.path);
          const key = rel.join('/').toLowerCase();
          if (seen.has(key)) refuse('name_exists', 409, `two entries are named ${rel.join('/')}`);
          seen.add(key);
          if (e.kind === 'file' && keys.some((k) => k.startsWith(`${key}/`))) refuse('name_exists', 409, `${rel.join('/')} is a file and a folder`);
          if (e.kind === 'dir') {
            items.push({ rel, kind: 'dir', date: null, protection: 0, comment: null });
          } else {
            let sha256: string;
            if (e.sizeBytes === 0) sha256 = emptySha!;
            else if (!e.sha256 || !whole(e.sha256, e.sizeBytes)) refuse('failed', 422, NOT_WHOLE);
            else sha256 = e.sha256;
            items.push({ rel, kind: 'file', sha256: sha256!, size: e.sizeBytes, date: e.lastModified ? new Date(e.lastModified) : null, protection: 0, comment: null });
          }
          if (rel.join('/') !== e.path.split('/').filter(Boolean).join('/')) renamed.push({ from: e.path, to: rel.join('/') });
        }
        // A folder before what it holds; a dropped file named like its own top comes first anyway.
        items.sort((a, b) => a.rel.length - b.rel.length);
        tops.push({ source, items });
        renamedIn.set(source, renamed);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        results.set(source, { source, ok: false, refusal: err.refusal });
      }
    }
    const r = tops.length ? await writeStash(ctx, dir, tops, onClash, 'browser') : null;
    if (r?.kind === 'clashes') return r;
    for (const i of r?.items ?? []) results.set(i.source, i);
    const renamed: { from: string; to: string }[] = [];
    for (const p of r?.placed ?? []) {
      const top = tops.find((t) => t.source === p.source)!;
      renamed.push(...renamedIn.get(p.source)!);
      const name = p.path.split('/').pop()!;
      if (name !== top.items[0].rel[0]) renamed.push({ from: top.items[0].rel[0], to: name });
    }
    return { kind: 'done', items: order.map((s) => results.get(s)!), versions: ctx.versions, ...(renamed.length ? { renamed } : {}) };
  } catch (e) {
    if (e instanceof Refused) return { kind: 'refused', refusal: e.refusal, status: e.status };
    throw e;
  }
}
