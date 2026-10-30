// src/lib/files/library-driver.ts
// The LIBRARY: driver (spec 2026-10-29 §4): copy, move, delete, makedir, rename, protect and comment within and between
// disk images. Every disk touched gets ONE applyDiskEdit -- one history version -- however many entries the op names.
// BlobUnavailableError becomes Refused('blob_unavailable', 503) at the driver boundary, on every method. SERVER ONLY.
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
import { childOf, formatPath, isWithin, parsePath, type FsPath } from './path';
import { diskStore } from '@/lib/storage';
import { BlobUnavailableError, listLibrary, loadDisk, readLibraryFile, readOnlyReasonOf, resolveInDisk, type ResolvedDisk } from './library';
import { opMemo, placeInLibrary } from './library-paths';
import type { RefusalCode } from './types';
import {
  checkComment, checkName, groupBy, itemResult, keepBothName, REMOVE_FAILED, refuse, Refused, skippedItem,
  type CopyMove, type FsCtx, type IncomingItem, type IncomingTop, type OnClash, type OpCtx, type OpItem, type Outcome, type VolumeDriver,
} from './driver';

type Run = OpCtx;

// ---- paths, disks, edits -------------------------------------------------------------------------------------

/** A LIBRARY: path inside a disk. `canon` is the same place without its collection prefix: what two paths of one disk
 *  are compared by (a cycle, an entry inside a folder), whichever form each came in (R2). */
type Loc = { path: FsPath; canon: FsPath; gameId: string; diskId: string; names: string[] };
type Disks = Map<string, ResolvedDisk>;
type Step = (adf: Uint8Array) => WriteResult;
type Hit = { entry: AdfEntry; parentBlock: number; dirBlock: number };

/** A LIBRARY: path inside a disk, reached directly or through a collection the title is filed in. */
async function locate(ctx: FsCtx, raw: string): Promise<Loc> {
  const path = parsePath(raw);
  if (!path) refuse('not_found', 404);
  if (path.device !== 'LIBRARY') refuse('unsupported', 400, `${path.device}: is not available yet`);
  const at = await placeInLibrary(ctx, path.segments, opMemo(ctx));
  if (!at) refuse('not_found', 404);
  if (at.level !== 'disk') refuse('unsupported', 400, 'not inside a disk');
  return { path, canon: { device: 'LIBRARY', segments: [at.gameId, at.diskId, ...at.names] }, gameId: at.gameId, diskId: at.diskId, names: at.names };
}

/** An entry, not a disk or title: what copy/move/delete/rename/protect/comment act on. */
async function locateEntry(ctx: FsCtx, raw: string): Promise<Loc> {
  const loc = await locate(ctx, raw);
  if (!loc.names.length) refuse('unsupported', 400, 'not an entry on a disk');
  return loc;
}

async function diskOf(ctx: FsCtx, cache: Disks, loc: Loc): Promise<ResolvedDisk> {
  const key = `${loc.gameId}/${loc.diskId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let d: ResolvedDisk | null;
  try { d = await loadDisk(ctx, loc.gameId, loc.diskId); } catch (e) { if (e instanceof BlobUnavailableError) refuse('blob_unavailable', 503, loc.diskId); throw e; }
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

async function edit(ctx: Run, d: ResolvedDisk, step: Step) {
  const o = await applyDiskEdit(ctx.orgId, d.info.diskId, step, ctx.userId);
  if (!o.ok) throw fromEdit(o);
  if (o.seq !== null) ctx.versions.push({ diskId: d.info.diskId, seq: o.seq });
}

// ---- copy and move -----------------------------------------------------------------------------------------

/** One entry of a copy, in walk order (a folder before what it holds), named relative to the destination folder. */
type PlanItem = IncomingItem;

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

async function copyOrMove(ctx: Run, req: CopyMove): Promise<Outcome> {
  const move = req.op === 'move';
  const cache: Disks = new Map();
  const destLoc = await locate(ctx, req.dest);
  const dd = await diskOf(ctx, cache, destLoc);
  const dest = dirAt(dd, destLoc);
  const intl = dd.intl;
  const same = (a: string, b: string) => sameName(a, b, intl);

  type Src = { raw: string; loc: Loc; d: ResolvedDisk; hit: Hit; local: boolean };
  const srcs: Src[] = [];
  for (const raw of req.sources) {
    const loc = await locateEntry(ctx, raw);
    const d = await diskOf(ctx, cache, loc);
    const hit = entryAt(d, loc);
    const local = d === dd;
    // A folder into itself or below: on the same disk only, where the two paths share a tree.
    if (local && hit.entry.kind === 'dir' && isWithin(destLoc.canon, loc.canon, same)) refuse('cycle', 400);
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
  const removeAfter: Removal[] = [];
  let freed = 0;
  const taken = (n: string) => dest.children.some((c) => same(c.name, n)) || placed.some((p) => same(p, n));
  for (const p of planned) {
    if (p.clash && req.onClash === 'skip') { results.set(p.raw, skippedItem(p.raw)); continue; }
    const item = itemResult(p.raw, () => {
      if (p.noop) return;
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
        if (p.local && isWithin(p.loc.canon, childOf(destLoc.canon, p.clash.name), same)) refuse('cycle', 400);
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
      if (move) removeAfter.push({ raw: p.raw, loc: p.loc, d: p.d, hit: p.hit, copied: mine });
    });
    results.set(p.raw, item);
  }

  await commitPlan(ctx, dd, destLoc, { adds, deletes, moves, freed });

  // A move between disks: the copies are written, so now each source disk loses its originals, one edit per disk.
  await removeCopied(ctx, removeAfter, results);
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!) };
}

type Plan = { adds: PlanItem[]; deletes: Step[]; moves: Step[]; freed: number };

/** The plan fits the destination disk, by the bytes each add carries or, before they are read, the size it says it has. */
function mustFit(dd: ResolvedDisk, plan: Plan) {
  const need = blocksForPlan(plan.adds.map((i): CostItem => ({ kind: i.kind, sizeBytes: i.bytes?.length ?? i.size ?? 0 })), dd.info.filesystem!);
  const usage = readUsage(dd.bytes);
  if (usage && need > usage.freeBlocks + plan.freed) {
    refuse('disk_full', 400, `needs ${Math.ceil(need / 2)} KB, ${Math.floor((usage.freeBlocks + plan.freed) / 2)} KB free`);
  }
}

/** Checks the plan fits the destination disk, then writes it as ONE edit: deletes, moves, then the batch of adds. */
async function commitPlan(ctx: Run, dd: ResolvedDisk, destLoc: Loc, plan: Plan) {
  const { adds, deletes, moves } = plan;
  mustFit(dd, plan);

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
}

type Removal = { raw: string; loc: Loc; d: ResolvedDisk; hit: Hit; copied: PlanItem[] };

/** Each source disk loses its originals, one edit per disk, each only while it is still what was copied. A disk whose edit is refused marks its items in `results`. */
async function removeCopied(ctx: Run, list: Removal[], results: Map<string, OpItem>) {
  for (const [d, group] of groupBy(list, (s) => s.d)) {
    try {
      await edit(ctx, d, chain(...deepestFirst(group).map((s) => onEntry(s.loc.names, (adf, h) => (
        stillAsCopied(adf, h, s) ? deleteEntry(adf, h.parentBlock, h.entry.block) : { ok: false, reason: CONFLICT })))));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      for (const s of group) results.set(s.raw, { source: s.raw, ok: false, refusal: { code: e.refusal.code, detail: REMOVE_FAILED } });
    }
  }
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

/** Children before their parents, so deleting both never deletes through an already-deleted folder. */
function deepestFirst<T extends { loc: Loc }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.loc.names.length - a.loc.names.length);
}

// ---- delete, protect: many entries, one edit per disk ------------------------------------------------------

/** One edit per disk, composing `step` for each source on it. One disk: its refusal is the op's; several: per item. */
async function perDisk(ctx: Run, sources: string[], step: (names: string[]) => Step, order: <T extends { loc: Loc }>(xs: T[]) => T[] = (xs) => xs): Promise<Outcome> {
  const cache: Disks = new Map();
  const located: { raw: string; loc: Loc; d: ResolvedDisk }[] = [];
  for (const raw of sources) {
    const loc = await locateEntry(ctx, raw);
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

function deleteMany(ctx: Run, sources: string[]): Promise<Outcome> {
  return perDisk(ctx, sources, (names) => onEntry(names, (adf, h) => deleteEntry(adf, h.parentBlock, h.entry.block)), deepestFirst);
}

function protectMany(ctx: Run, sources: string[], protection: number): Promise<Outcome> {
  if (!Number.isInteger(protection) || protection < 0 || protection > 0xff) refuse('unsupported', 400, 'protection is 8 bits');
  // Only the eight bits the browser shows: multi-user bits above them stay as they were.
  return perDisk(ctx, sources, (names) => onEntry(names, (adf, h) => setProtection(adf, h.parentBlock, h.entry.block, protection, 0xff)));
}

// ---- one entry: rename, comment, makedir -------------------------------------------------------------------

async function onOne(ctx: Run, loc: Loc, source: string, step: Step): Promise<Outcome> {
  const d = await diskOf(ctx, new Map(), loc);
  entryAt(d, loc);
  mustBeWritable(d);
  await edit(ctx, d, step);
  return { kind: 'done', items: [{ source, ok: true }] };
}

async function renameOne(ctx: Run, source: string, name: string): Promise<Outcome> {
  checkName(name);
  const loc = await locateEntry(ctx, source);
  return onOne(ctx, loc, source, onEntry(loc.names, (adf, h) => renameEntry(adf, h.parentBlock, h.entry.block, name)));
}

async function commentOne(ctx: Run, source: string, comment: string): Promise<Outcome> {
  checkComment(comment);
  const loc = await locateEntry(ctx, source);
  return onOne(ctx, loc, source, onEntry(loc.names, (adf, h) => setComment(adf, h.parentBlock, h.entry.block, comment)));
}

async function makeDir(ctx: Run, destRaw: string, name: string): Promise<Outcome> {
  checkName(name);
  const loc = await locate(ctx, destRaw);
  const d = await diskOf(ctx, new Map(), loc);
  const dir = dirAt(d, loc);
  mustBeWritable(d);
  if (dir.children.some((c) => sameName(c.name, name, d.intl))) refuse('name_exists', 409);
  await edit(ctx, d, applyBatch([{ op: 'mkdir', parentPath: loc.names.join('/'), name }]));
  return { kind: 'done', items: [{ source: formatPath(childOf(loc.path, name)), ok: true }] };
}

// ---- the driver ----------------------------------------------------------------------------------------------

/** One entry walked for a copy to another device; null when it is not there. */
async function collect(ctx: FsCtx, p: FsPath): Promise<IncomingItem[] | null> {
  try {
    const loc = await locateEntry(ctx, formatPath(p));
    const d = await diskOf(ctx, new Map(), loc);
    const hit = entryAt(d, loc);
    const out: PlanItem[] = [];
    walk(d.bytes, hit.entry, [hit.entry.name], out);
    out[0] = { ...out[0], id: String(hit.entry.block) };   // what remove(unchanged) holds the original to
    return out;
  } catch (e) {
    if (e instanceof Refused && e.refusal.code === 'not_found') return null;
    throw e;
  }
}

/** Entries from another device (or this one) written into one folder of a disk: ONE edit, however many tops. */
async function write(ctx: Run, dir: FsPath, tops: IncomingTop[], onClash: OnClash): Promise<Outcome> {
  const destLoc = await locate(ctx, formatPath(dir));
  const dd = await diskOf(ctx, new Map(), destLoc);
  const dest = dirAt(dd, destLoc);
  mustBeWritable(dd);
  const same = (a: string, b: string) => sameName(a, b, dd.intl);
  const fs = dd.info.filesystem!;

  const placed: string[] = [];
  const results = new Map<string, OpItem>();
  const planned: { top: IncomingTop; name: string; clash: AdfEntry | null }[] = [];
  for (const top of tops) {
    const name = top.items[0]?.rel[0] ?? '';
    const item = itemResult(top.source, () => {
      for (const i of top.items) {
        checkName(i.rel[i.rel.length - 1]);
        if (i.kind === 'file' && !i.bytes && !i.sha256) refuse('failed', 500, `${i.rel.join('/')} came without its bytes`);
      }
      checkName(name);
      if (placed.some((n) => same(n, name))) refuse('name_exists', 409, 'two sources share a name');
    });
    if (!item.ok) { results.set(top.source, item); continue; }
    placed.push(name);
    planned.push({ top, name, clash: dest.children.find((c) => same(c.name, name)) ?? null });
  }
  if (onClash === 'ask') {
    const clashes = planned.filter((p) => p.clash).map((p) => ({ source: p.top.source, name: p.name, dest: formatPath(destLoc.path) }));
    if (clashes.length) return { kind: 'clashes', clashes };
  }

  const plan: Plan = { adds: [], deletes: [], moves: [], freed: 0 };
  const written: string[] = [];
  const taken = (n: string) => dest.children.some((c) => same(c.name, n)) || placed.some((p) => same(p, n));
  for (const p of planned) {
    if (p.clash && onClash === 'skip') { results.set(p.top.source, skippedItem(p.top.source)); continue; }
    results.set(p.top.source, itemResult(p.top.source, () => {
      let name = p.name;
      if (p.clash && onClash === 'keep-both') { name = keepBothName(name, taken); placed.push(name); }
      if (p.clash && onClash === 'replace') {
        plan.deletes.push(onEntry([...destLoc.names, p.clash.name], (adf, h) => deleteEntry(adf, h.parentBlock, h.entry.block)));
        plan.freed += blocksOf(p.clash, fs);
      }
      plan.adds.push(...p.top.items.map((i) => ({ ...i, rel: [name, ...i.rel.slice(1)] })));
      written.push(p.top.source);
    }));
  }
  // Ruling 13: what fits is judged by the sizes the items carry, then the bytes that are only named by sha-256 are read.
  mustFit(dd, plan);
  plan.adds = await Promise.all(plan.adds.map(async (i) => (i.kind === 'file' && !i.bytes
    ? { ...i, bytes: await diskStore.read(i.sha256!).catch((): never => refuse('blob_unavailable', 503)) } : i)));
  await commitPlan(ctx, dd, destLoc, plan);
  return { kind: 'done', items: tops.map((t) => results.get(t.source)!), written };
}

/** Delete; with `unchanged`, each source only while it is still exactly what was collected (a move's second half). */
async function remove(ctx: Run, sources: string[], unchanged?: ReadonlyMap<string, IncomingItem[]>): Promise<Outcome> {
  if (!unchanged) return deleteMany(ctx, sources);
  const cache: Disks = new Map();
  const results = new Map<string, OpItem>();
  const list: Removal[] = [];
  for (const raw of sources) {
    try {
      const loc = await locateEntry(ctx, raw);
      const d = await diskOf(ctx, cache, loc);
      const hit = entryAt(d, loc);
      const copied = unchanged.get(raw);
      if (!copied) refuse('failed', 500, 'nothing was collected from it');
      // Not the entry collected: one deleted and made again since, however alike, was never copied.
      if (copied[0]?.id !== undefined && copied[0].id !== String(hit.entry.block)) refuse('conflict', 409);
      list.push({ raw, loc, d, hit, copied });
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      results.set(raw, { source: raw, ok: false, refusal: { code: e.refusal.code, detail: REMOVE_FAILED } });
    }
  }
  await removeCopied(ctx, list, results);
  return { kind: 'done', items: sources.map((s) => results.get(s) ?? { source: s, ok: true }) };
}

/** A move's sources, before anything is written: each there, on a disk that can be changed (held, HFE: refused). */
async function mustRemove(ctx: FsCtx, sources: string[]): Promise<void> {
  const cache: Disks = new Map();
  for (const raw of sources) {
    const loc = await locateEntry(ctx, raw);
    const d = await diskOf(ctx, cache, loc);
    entryAt(d, loc);
    mustBeWritable(d);
  }
}

async function setMeta(ctx: Run, sources: string[], meta: { protection?: number; comment?: string }): Promise<Outcome> {
  if (meta.protection !== undefined && meta.comment !== undefined) refuse('unsupported', 400, 'one change at a time');
  if (meta.protection !== undefined) return protectMany(ctx, sources, meta.protection);
  if (meta.comment !== undefined) {
    if (sources.length !== 1) refuse('unsupported', 400, 'one comment at a time');
    return commentOne(ctx, sources[0], meta.comment);
  }
  refuse('unsupported', 400, 'nothing to change');
}

/** BlobUnavailableError (a disk whose image the store cannot give) is the driver's refusal 503, whichever method met it. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof BlobUnavailableError) refuse('blob_unavailable', 503, e.diskId);
    throw e;
  }
}

export const libraryDriver: VolumeDriver = {
  device: 'LIBRARY',
  list: (ctx, p) => guarded(() => listLibrary(ctx, p)),
  read: async (ctx, p) => {
    const f = await guarded(() => readLibraryFile(ctx, p));
    return f && { name: f.name, bytes: f.bytes, date: f.date, protection: f.protection, comment: f.comment };
  },
  collect: (ctx, p) => guarded(() => collect(ctx, p)),
  within: (ctx, req: CopyMove) => guarded(() => copyOrMove(ctx, req)),
  write: (ctx, dir, tops, onClash) => guarded(() => write(ctx, dir, tops, onClash)),
  remove: (ctx, sources, unchanged) => guarded(() => remove(ctx, sources, unchanged)),
  mustRemove: (ctx, sources) => guarded(() => mustRemove(ctx, sources)),
  makedir: (ctx, dir, name) => guarded(() => makeDir(ctx, formatPath(dir), name)),
  rename: (ctx, source, name) => guarded(() => renameOne(ctx, source, name)),
  setMeta: (ctx, sources, meta) => guarded(() => setMeta(ctx, sources, meta)),
};
