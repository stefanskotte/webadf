// src/lib/files/driver.ts
// The seam between the Files engine and a device's storage (spec 2026-10-29 §3, increment 2): one VolumeDriver per
// device (LIBRARY:, STASH:, later NET:). ops.ts dispatches by the path's device; the routes list and read through the
// driver. A driver refuses by throwing Refused, so BlobUnavailableError never leaves LIBRARY's driver. SERVER ONLY.
import { amigaNameProblem, AMIGA_COMMENT_MAX, type Device, type FsPath } from './path';
import type { Listing, Refusal, RefusalCode } from './types';
import type { OpVersion } from './edit-rules';

export type FsCtx = { orgId: string; userId: string | null };
/** The caller's context while an op runs, collecting every history version its edits save. */
export type OpCtx = FsCtx & { versions: OpVersion[] };
export type OnClash = 'ask' | 'replace' | 'skip' | 'keep-both';
export type OpItem = { source: string; ok: true } | { source: string; ok: false; refusal: Refusal };
export type Clash = { source: string; name: string; dest: string };
/** A disk image Add to library placed (Task 5). */
export type Added = { source: string; gameId: string; diskId: string };
/**
 * `written`: the sources a write actually placed (not skipped, not refused). A move between devices removes only these
 * (ruling 1); runOp does not pass it on.
 */
export type Outcome = { kind: 'done'; items: OpItem[]; added?: Added[]; written?: string[] } | { kind: 'clashes'; clashes: Clash[] };
export type FileBytes = { name: string; bytes: Uint8Array; date: Date | null; protection: string; comment: string | null };
/**
 * One entry of a copy, a folder before what it holds; rel[0] is the copied entry's own name. `sha256` when the bytes are
 * already in diskStore, then `size` says how many there are, so a writer can refuse what does not fit before reading
 * them (ruling 13). `id`: what the entry was on its own device when collected (a STASH: row id, a LIBRARY: header
 * block), so a move's remove can tell the original from something made in its place since.
 */
export type IncomingItem = {
  rel: string[]; kind: 'file' | 'dir'; bytes?: Uint8Array; sha256?: string; size?: number; id?: string;
  date: Date | null; protection: number; comment: string | null;
};
export type IncomingTop = { source: string; items: IncomingItem[] };
export type CopyMove = { op: 'copy' | 'move'; sources: string[]; dest: string; onClash: OnClash };

/** A refusal thrown from anywhere below runOp; runOp (or a per-item catch) turns it into a result. */
export class Refused extends Error {
  constructor(readonly refusal: Refusal, readonly status: number) { super(refusal.code); }
}
export function refuse(code: RefusalCode, status: number, detail?: string): never {
  throw new Refused(detail ? { code, detail } : { code }, status);
}

export function checkName(name: string): void {
  const problem = amigaNameProblem(name);
  if (problem) refuse('bad_name', 400, problem);
}

/** adffs stores a comment's characters as bytes, so the engine is the one place that keeps them Latin-1. */
export function checkComment(comment: string): void {
  if (comment.length > AMIGA_COMMENT_MAX) refuse('comment_too_long', 400, `at most ${AMIGA_COMMENT_MAX} characters`);
  if (/[^\x20-\x7E\xA0-\xFF]/.test(comment)) refuse('bad_name', 400, 'comment');
}

export { keepBothName } from './stash-paths';

export const REMOVE_FAILED = 'copied, but the original could not be removed';

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** Run `fn` for one item; a refusal becomes that item's result instead of the whole op's. */
export function itemResult(source: string, fn: () => void): OpItem {
  try { fn(); return { source, ok: true }; } catch (e) {
    if (e instanceof Refused) return { source, ok: false, refusal: e.refusal };
    throw e;
  }
}

export interface VolumeDriver {
  readonly device: Device;
  list(ctx: FsCtx, p: FsPath): Promise<Listing | null>;                // null = not found (404)
  read(ctx: FsCtx, p: FsPath): Promise<FileBytes | null>;              // a file's bytes + meta; null for a folder or not found
  collect(ctx: FsCtx, p: FsPath): Promise<IncomingItem[] | null>;      // one entry walked, for a copy to another device
  within?(ctx: OpCtx, req: CopyMove): Promise<Outcome>;                // copy/move with every source and the dest on this device
  write?(ctx: OpCtx, dir: FsPath, tops: IncomingTop[], onClash: OnClash): Promise<Outcome>;   // absent = read-only device
  /** With `unchanged`, a source is removed only while it is still exactly what was collected (a move's second half). */
  remove?(ctx: OpCtx, sources: string[], unchanged?: ReadonlyMap<string, IncomingItem[]>): Promise<Outcome>;
  /** Refuses (throws) unless every source could be removed now: what a move between devices asks before it writes. */
  mustRemove?(ctx: FsCtx, sources: string[]): Promise<void>;
  makedir?(ctx: OpCtx, dir: FsPath, name: string): Promise<Outcome>;
  rename?(ctx: OpCtx, source: string, name: string): Promise<Outcome>;
  setMeta?(ctx: OpCtx, sources: string[], meta: { protection?: number; comment?: string }): Promise<Outcome>;
}
