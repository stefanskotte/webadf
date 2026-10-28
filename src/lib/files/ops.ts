// src/lib/files/ops.ts
// The Files ops engine for LIBRARY: (spec 2026-10-29 §4): copy, move, delete, makedir, rename, protect and comment
// within and between disk images. Every disk touched gets ONE applyDiskEdit -- one history version -- however
// many entries the op names. SERVER ONLY.
//
// Each step of an edit resolves its entry BY PATH against the bytes it is handed, never by a block number from the
// earlier read: applyDiskEdit hands the edit whatever the store holds now, and a path is what survives in between.
import {
  applyBatch, blocksForFile, blocksForPlan, deleteEntry, moveEntry, readFile, readUsage, readVolume, renameEntry,
  setComment, setProtection, type AdfEntry, type BatchOp, type CostItem, type WriteError, type WriteResult,
} from '@/lib/adffs';
import { sameName } from '@/lib/adffs/write';
import { applyDiskEdit, type DiskEditOutcome } from '@/lib/disk-write';
import { isMountedReason } from '@/lib/mount-wording';
import { AMIGA_COMMENT_MAX, AMIGA_NAME_MAX, amigaNameProblem, childOf, formatPath, isWithin, parsePath, type FsPath } from './path';
import { BlobUnavailableError, loadDisk, readOnlyReasonOf, resolveInDisk, type FsCtx, type ResolvedDisk } from './library';
import type { Refusal, RefusalCode } from './types';

export type OpRequest =
  | { op: 'copy' | 'move'; sources: string[]; dest: string; onClash: 'ask' | 'replace' | 'skip' | 'keep-both' }
  | { op: 'delete'; sources: string[] }
  | { op: 'makedir'; dest: string; name: string }
  | { op: 'rename'; source: string; name: string }
  | { op: 'protect'; sources: string[]; protection: number }      // AmigaDOS bits, 0..0xff, as files/[block] PATCH takes
  | { op: 'comment'; source: string; comment: string };
export type OpItem = { source: string; ok: true } | { source: string; ok: false; refusal: Refusal };
export type OpResult =
  | { kind: 'done'; items: OpItem[] }
  | { kind: 'clashes'; clashes: { source: string; name: string; dest: string }[] }
  | { kind: 'refused'; refusal: Refusal; status: number };

/** A refusal thrown from anywhere below runOp; runOp (or a per-item catch) turns it into a result. */
class Refused extends Error {
  constructor(readonly refusal: Refusal, readonly status: number) { super(refusal.code); }
}
function refuse(code: RefusalCode, status: number, detail?: string): never {
  throw new Refused(detail ? { code, detail } : { code }, status);
}

export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult> {
  try {
    switch (req.op) {
      case 'copy': case 'move': return await copyOrMove(ctx, req);
      case 'delete': return await deleteMany(ctx, req.sources);
      case 'makedir': return await makeDir(ctx, req.dest, req.name);
      case 'rename': return await renameOne(ctx, req.source, req.name);
      case 'protect': return await protectMany(ctx, req.sources, req.protection);
      case 'comment': return await commentOne(ctx, req.source, req.comment);
    }
  } catch (e) {
    if (e instanceof Refused) return { kind: 'refused', refusal: e.refusal, status: e.status };
    throw e;
  }
}

/** 'ReadMe' → 'ReadMe_1', 'a.txt' → 'a_1.txt': the first free number, the stem trimmed to keep the name ≤ 30. */
export function keepBothName(name: string, taken: (n: string) => boolean): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext0] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const suffix = `_${n}`;
    const ext = ext0.length + suffix.length < AMIGA_NAME_MAX ? ext0 : '';
    const candidate = stem.slice(0, AMIGA_NAME_MAX - suffix.length - ext.length) + suffix + ext;
    if (!taken(candidate)) return candidate;
  }
}

// ---- paths, disks, edits -------------------------------------------------------------------------------------

type Loc = { path: FsPath; gameId: string; diskId: string; names: string[] };
type Disks = Map<string, ResolvedDisk>;
type Step = (adf: Uint8Array) => WriteResult;
type Hit = { entry: AdfEntry; parentBlock: number; dirBlock: number };

/** A LIBRARY: path inside a disk. Other devices arrive in later increments. */
function locate(raw: string): Loc {
  const path = parsePath(raw);
  if (!path) refuse('not_found', 404);
  if (path.device !== 'LIBRARY') refuse('unsupported', 400, `${path.device}: is not available yet`);
  const [gameId, diskId, ...names] = path.segments;
  if (!gameId || !diskId) refuse('unsupported', 400, 'not inside a disk');
  return { path, gameId, diskId, names };
}

/** An entry, not a disk or title: what copy/move/delete/rename/protect/comment act on. */
function locateEntry(raw: string): Loc {
  const loc = locate(raw);
  if (!loc.names.length) refuse('unsupported', 400, 'not an entry on a disk');
  return loc;
}

async function diskOf(ctx: FsCtx, cache: Disks, loc: Loc): Promise<ResolvedDisk> {
  const key = `${loc.gameId}/${loc.diskId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let d: ResolvedDisk | null;
  try { d = await loadDisk(ctx, loc.gameId, loc.diskId); } catch (e) { if (e instanceof BlobUnavailableError) refuse('blob_unavailable', 503); throw e; }
  if (!d) refuse('not_found', 404);
  cache.set(key, d);
  return d;
}

function mustBeWritable(d: ResolvedDisk) {
  const why = readOnlyReasonOf(d.info);
  if (why) refuse('read_only', 409, why);
}

function entryAt(d: ResolvedDisk, loc: Loc): Hit {
  const at = resolveInDisk(d, loc.names);
  if (!at?.entry) refuse('not_found', 404);
  return { entry: at.entry, parentBlock: at.parentBlock, dirBlock: at.dirBlock };
}

function dirAt(d: ResolvedDisk, loc: Loc): { block: number; children: AdfEntry[] } {
  const at = resolveInDisk(d, loc.names);
  if (!at || (at.entry && at.entry.kind !== 'dir')) refuse('not_found', 404);
  return at.entry ? { block: at.entry.block, children: at.entry.children } : { block: d.rootBlock, children: d.root };
}

function checkName(name: string) {
  const problem = amigaNameProblem(name);
  if (problem) refuse('bad_name', 400, problem);
}

/** adffs stores a comment's characters as bytes, so the engine is the one place that keeps them Latin-1. */
function checkComment(comment: string) {
  if (comment.length > AMIGA_COMMENT_MAX) refuse('comment_too_long', 400, `at most ${AMIGA_COMMENT_MAX} characters`);
  if (/[^\x20-\x7E\xA0-\xFF]/.test(comment)) refuse('bad_name', 400, 'comment');
}

const chain = (...steps: Step[]): Step => (adf) => {
  let cur = adf;
  for (const s of steps) { const r = s(cur); if (!r.ok) return r; cur = r.adf; }
  return { ok: true, adf: cur };
};

/** A step that finds `names` in the bytes it is given (the disk root when `names` is empty: entry null). */
function at(names: string[], fn: (adf: Uint8Array, hit: Hit | { entry: null; parentBlock: number; dirBlock: number }) => WriteResult): Step {
  return (adf) => {
    const v = readVolume(adf);
    if (!v.ok) return { ok: false, reason: 'no-filesystem' };
    const hit = resolveInDisk({ root: v.root, rootBlock: v.rootBlock, intl: v.volume.intl }, names);
    if (!hit || (names.length && !hit.entry)) return { ok: false, reason: 'not-found' };
    return fn(adf, hit);
  };
}
const onEntry = (names: string[], fn: (adf: Uint8Array, hit: Hit) => WriteResult): Step =>
  at(names, (adf, hit) => (hit.entry ? fn(adf, hit as Hit) : { ok: false, reason: 'not-found' }));

/** THE one mapping from an applyDiskEdit failure to a refusal. */
function fromEdit(o: Extract<DiskEditOutcome, { ok: false }>): Refused {
  if (isMountedReason(o.reason)) return new Refused({ code: 'mounted', detail: o.reason }, 409);
  const known: Record<string, [RefusalCode, number]> = {
    not_found: ['not_found', 404], 'not-found': ['not_found', 404], conflict: ['conflict', 409],
    hfe_read_only: ['hfe_read_only', 409], 'disk-full': ['disk_full', 400], 'name-exists': ['name_exists', 409],
    'name-too-long': ['bad_name', 400], cycle: ['cycle', 400], 'comment-too-long': ['comment_too_long', 400],
    'no-filesystem': ['no_filesystem', 409], blob_unavailable: ['blob_unavailable', 503],
  };
  const hit = known[o.reason] ?? (o.status === 503 ? ['blob_unavailable', 503] as [RefusalCode, number] : null);
  return hit ? new Refused({ code: hit[0] }, hit[1]) : new Refused({ code: 'failed', detail: o.reason }, o.status);
}

async function edit(ctx: FsCtx, d: ResolvedDisk, step: Step) {
  const o = await applyDiskEdit(ctx.orgId, d.info.diskId, step, ctx.userId);
  if (!o.ok) throw fromEdit(o);
}

/** Run `fn` for one item; a refusal becomes that item's result instead of the whole op's. */
function itemResult(source: string, fn: () => void): OpItem {
  try { fn(); return { source, ok: true }; } catch (e) {
    if (e instanceof Refused) return { source, ok: false, refusal: e.refusal };
    throw e;
  }
}

// ---- copy and move -----------------------------------------------------------------------------------------

/** One entry of a copy, in walk order (a folder before what it holds), named relative to the destination folder. */
type PlanItem = { rel: string[]; kind: 'file' | 'dir'; bytes?: Uint8Array; date: Date | null; protection: number; comment: string | null };

/** "hsparwed" (dir.ts protectionString) back to the bits: the low four (rwed) are inverted, a dash is a set bit. */
function protectionBits(s: string): number {
  let bits = 0;
  for (let i = 0; i < 4; i++) if (s[i] !== '-') bits |= 0x80 >> i;
  for (let i = 0; i < 4; i++) if (s[4 + i] === '-') bits |= 0x08 >> i;
  return bits;
}

function walk(bytes: Uint8Array, e: AdfEntry, rel: string[], out: PlanItem[]) {
  checkName(e.name);
  const base = { rel, kind: e.kind, date: e.modifiedAt, protection: protectionBits(e.protection), comment: e.comment };
  if (e.kind === 'dir') {
    out.push(base);
    for (const c of e.children) walk(bytes, c, [...rel, c.name], out);
    return;
  }
  const f = readFile(bytes, e.block);
  if (!f?.complete) refuse('failed', 500, `${e.name} cannot be read whole`);
  out.push({ ...base, bytes: f.bytes });
}

/** Blocks an existing entry frees when `replace` deletes it. */
function blocksOf(e: AdfEntry, fs: 'OFS' | 'FFS'): number {
  return e.kind === 'file' ? blocksForFile(e.sizeBytes, fs) : 1 + e.children.reduce((n, c) => n + blocksOf(c, fs), 0);
}

async function copyOrMove(ctx: FsCtx, req: Extract<OpRequest, { op: 'copy' | 'move' }>): Promise<OpResult> {
  const move = req.op === 'move';
  const cache: Disks = new Map();
  const destLoc = locate(req.dest);
  const dd = await diskOf(ctx, cache, destLoc);
  const dest = dirAt(dd, destLoc);
  const intl = dd.intl;
  const same = (a: string, b: string) => sameName(a, b, intl);

  type Src = { raw: string; loc: Loc; d: ResolvedDisk; hit: Hit; local: boolean };
  const srcs: Src[] = [];
  for (const raw of req.sources) {
    const loc = locateEntry(raw);
    const d = await diskOf(ctx, cache, loc);
    const hit = entryAt(d, loc);
    const local = d === dd;
    // A folder into itself or below: on the same disk only, where the two paths share a tree.
    if (local && hit.entry.kind === 'dir' && isWithin(destLoc.path, loc.path, same)) refuse('cycle', 400);
    srcs.push({ raw, loc, d, hit, local });
  }
  mustBeWritable(dd);
  if (move) for (const s of srcs) mustBeWritable(s.d);

  // Top-level clashes, against the destination and against names this op has already placed there.
  const placed: string[] = [];
  const results = new Map<string, OpItem>();
  type Planned = Src & { clash: AdfEntry | null; noop: boolean };
  const planned: Planned[] = [];
  for (const s of srcs) {
    const noop = move && s.local && s.hit.parentBlock === dest.block;   // moved to where it already is
    // A copy into its own folder clashes with itself: the person picks keep-both.
    const clash = noop ? null : dest.children.find((c) => same(c.name, s.hit.entry.name)) ?? null;
    const item = itemResult(s.raw, () => {
      checkName(s.hit.entry.name);
      if (!noop && placed.some((n) => same(n, s.hit.entry.name))) refuse('name_exists', 409, 'two sources share a name');
    });
    if (!item.ok) { results.set(s.raw, item); continue; }
    placed.push(s.hit.entry.name);
    planned.push({ ...s, clash, noop });
  }
  if (req.onClash === 'ask') {
    const clashes = planned.filter((p) => p.clash).map((p) => ({ source: p.raw, name: p.hit.entry.name, dest: formatPath(destLoc.path) }));
    if (clashes.length) return { kind: 'clashes', clashes };
  }

  const fs = dd.info.filesystem!;
  const deletes: Step[] = []; const moves: Step[] = []; const adds: PlanItem[] = [];
  const removeAfter: (Src & { copied: PlanItem[] })[] = [];
  let freed = 0;
  const taken = (n: string) => dest.children.some((c) => same(c.name, n)) || placed.some((p) => same(p, n));
  for (const p of planned) {
    const item = itemResult(p.raw, () => {
      if (p.noop || (p.clash && req.onClash === 'skip')) return;
      let name = p.hit.entry.name;
      if (p.clash && req.onClash === 'keep-both') {
        const siblings = p.local && move ? resolveInDisk(p.d, p.loc.names.slice(0, -1))?.entry?.children ?? p.d.root : [];
        name = keepBothName(name, (n) => taken(n) || siblings.some((c) => c.block !== p.hit.entry.block && same(c.name, n)));
        placed.push(name);
      }
      // Everything that can refuse this item runs before any of its steps is queued.
      const mine: PlanItem[] = [];
      if (!(move && p.local)) walk(p.d.bytes, p.hit.entry, [name], mine);
      if (p.clash && req.onClash === 'replace') {
        // Deleting what the source sits inside (or is) would delete the source with it.
        if (p.local && p.clash.block === p.hit.entry.block && p.clash.kind === 'file') refuse('name_exists', 409, 'same file');
        if (p.local && isWithin(p.loc.path, childOf(destLoc.path, p.clash.name), same)) refuse('cycle', 400);
        deletes.push(onEntry([...destLoc.names, p.clash.name], (adf, h) => deleteEntry(adf, h.parentBlock, h.entry.block)));
        freed += blocksOf(p.clash, fs);
      }
      if (move && p.local) {
        const renamed = name !== p.hit.entry.name;
        const from = renamed ? [...p.loc.names.slice(0, -1), name] : p.loc.names;
        if (renamed) moves.push(onEntry(p.loc.names, (adf, h) => renameEntry(adf, h.parentBlock, h.entry.block, name)));
        moves.push(onEntry(from, (adf, h) => at(destLoc.names, (a, dh) => moveEntry(a, h.parentBlock, h.entry.block, dh.dirBlock))(adf)));
        return;
      }
      adds.push(...mine);
      if (move) removeAfter.push({ ...p, copied: mine });
    });
    results.set(p.raw, item);
  }

  const need = blocksForPlan(adds.map((i): CostItem => ({ kind: i.kind, sizeBytes: i.bytes?.length ?? 0 })), fs);
  const usage = readUsage(dd.bytes);
  if (usage && need > usage.freeBlocks + freed) {
    refuse('disk_full', 400, `needs ${Math.ceil(need / 2)} KB, ${Math.floor((usage.freeBlocks + freed) / 2)} KB free`);
  }

  if (deletes.length || moves.length || adds.length) {
    const parentPath = (rel: string[]) => [...destLoc.names, ...rel.slice(0, -1)].join('/');
    const ops: BatchOp[] = adds.map((i) => {
      const meta = { parentPath: parentPath(i.rel), name: i.rel[i.rel.length - 1], date: i.date ?? undefined, comment: i.comment ?? undefined };
      return i.kind === 'dir' ? { op: 'mkdir', ...meta } : { op: 'add', ...meta, bytes: i.bytes!, protection: i.protection };
    });
    // makeDirectory takes no protection bits; a folder that had any gets them after the batch made it.
    const dirBits = adds.filter((i) => i.kind === 'dir' && i.protection !== 0)
      .map((i) => onEntry([...destLoc.names, ...i.rel], (adf, h) => setProtection(adf, h.parentBlock, h.entry.block, i.protection, 0xff)));
    await edit(ctx, dd, chain(...deletes, ...moves, applyBatch(ops), ...dirBits));
  }

  // A move between disks: the copies are written, so now each source disk loses its originals, one edit per disk.
  for (const [d, list] of groupBy(removeAfter, (s) => s.d)) {
    try {
      await edit(ctx, d, chain(...deepestFirst(list).map((s) => onEntry(s.loc.names, (adf, h) => (
        stillAsCopied(adf, h, s) ? deleteEntry(adf, h.parentBlock, h.entry.block) : { ok: false, reason: CONFLICT })))));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      for (const s of list) results.set(s.raw, { source: s.raw, ok: false, refusal: { code: e.refusal.code, detail: 'copied, but the original could not be removed' } });
    }
  }
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!) };
}

// Not an adffs WriteError: the engine's own refusal, which applyDiskEdit passes through and fromEdit maps to `conflict`.
const CONFLICT = 'conflict' as WriteError;

/**
 * The original about to be deleted is exactly what was copied: the same header block, and a fresh walk of it gives the
 * same names, bytes, dates, bits and comments. The copy was read from the snapshot loadDisk took; anything saved to the
 * source since (a board's write, another tab) would otherwise be deleted without ever having been copied.
 */
function stillAsCopied(adf: Uint8Array, h: Hit, s: { hit: Hit; copied: PlanItem[] }): boolean {
  if (h.entry.block !== s.hit.entry.block) return false;
  const now: PlanItem[] = [];
  try { walk(adf, h.entry, s.copied[0].rel, now); } catch (e) { if (e instanceof Refused) return false; throw e; }
  const sameBytes = (a?: Uint8Array, b?: Uint8Array) => (!a && !b) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
  return now.length === s.copied.length && now.every((n, i) => {
    const c = s.copied[i];
    return n.rel.join('/') === c.rel.join('/') && n.kind === c.kind && n.protection === c.protection && n.comment === c.comment
      && n.date?.getTime() === c.date?.getTime() && sameBytes(n.bytes, c.bytes);
  });
}

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** Children before their parents, so deleting both never deletes through an already-deleted folder. */
function deepestFirst<T extends { loc: Loc }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.loc.names.length - a.loc.names.length);
}

// ---- delete, protect: many entries, one edit per disk ------------------------------------------------------

/** One edit per disk, composing `step` for each source on it. One disk: its refusal is the op's; several: per item. */
async function perDisk(ctx: FsCtx, sources: string[], step: (names: string[]) => Step, order: <T extends { loc: Loc }>(xs: T[]) => T[] = (xs) => xs): Promise<OpResult> {
  const cache: Disks = new Map();
  const located: { raw: string; loc: Loc; d: ResolvedDisk }[] = [];
  for (const raw of sources) {
    const loc = locateEntry(raw);
    const d = await diskOf(ctx, cache, loc);
    entryAt(d, loc);
    located.push({ raw, loc, d });
  }
  const groups = groupBy(located, (s) => s.d);
  const results = new Map<string, OpItem>();
  for (const [d, list] of groups) {
    try {
      mustBeWritable(d);
      await edit(ctx, d, chain(...order(list).map((s) => step(s.loc.names))));
      for (const s of list) results.set(s.raw, { source: s.raw, ok: true });
    } catch (e) {
      if (!(e instanceof Refused) || groups.size === 1) throw e;
      for (const s of list) results.set(s.raw, { source: s.raw, ok: false, refusal: e.refusal });
    }
  }
  return { kind: 'done', items: sources.map((s) => results.get(s)!) };
}

function deleteMany(ctx: FsCtx, sources: string[]): Promise<OpResult> {
  return perDisk(ctx, sources, (names) => onEntry(names, (adf, h) => deleteEntry(adf, h.parentBlock, h.entry.block)), deepestFirst);
}

function protectMany(ctx: FsCtx, sources: string[], protection: number): Promise<OpResult> {
  if (!Number.isInteger(protection) || protection < 0 || protection > 0xff) refuse('unsupported', 400, 'protection is 8 bits');
  // Only the eight bits the browser shows: multi-user bits above them stay as they were.
  return perDisk(ctx, sources, (names) => onEntry(names, (adf, h) => setProtection(adf, h.parentBlock, h.entry.block, protection, 0xff)));
}

// ---- one entry: rename, comment, makedir -------------------------------------------------------------------

async function onOne(ctx: FsCtx, source: string, step: Step): Promise<OpResult> {
  const loc = locateEntry(source);
  const d = await diskOf(ctx, new Map(), loc);
  entryAt(d, loc);
  mustBeWritable(d);
  await edit(ctx, d, step);
  return { kind: 'done', items: [{ source, ok: true }] };
}

function renameOne(ctx: FsCtx, source: string, name: string): Promise<OpResult> {
  checkName(name);
  return onOne(ctx, source, onEntry(locateEntry(source).names, (adf, h) => renameEntry(adf, h.parentBlock, h.entry.block, name)));
}

function commentOne(ctx: FsCtx, source: string, comment: string): Promise<OpResult> {
  checkComment(comment);
  return onOne(ctx, source, onEntry(locateEntry(source).names, (adf, h) => setComment(adf, h.parentBlock, h.entry.block, comment)));
}

async function makeDir(ctx: FsCtx, destRaw: string, name: string): Promise<OpResult> {
  checkName(name);
  const loc = locate(destRaw);
  const d = await diskOf(ctx, new Map(), loc);
  const dir = dirAt(d, loc);
  mustBeWritable(d);
  if (dir.children.some((c) => sameName(c.name, name, d.intl))) refuse('name_exists', 409);
  await edit(ctx, d, applyBatch([{ op: 'mkdir', parentPath: loc.names.join('/'), name }]));
  return { kind: 'done', items: [{ source: formatPath(childOf(loc.path, name)), ok: true }] };
}
