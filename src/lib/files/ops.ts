// src/lib/files/ops.ts
// The Files ops engine's front door (spec 2026-10-29 §4): copy, move, delete, makedir, rename, protect, comment and
// Add to library. It sends each op to the driver of the device its paths name (drivers.ts); a device's storage rules
// live in its driver (LIBRARY: library-driver.ts, STASH: stash-driver.ts). A copy or move between devices is collect on
// the source's driver, write on the destination's, then (a move) remove of what was written. NET: (net-driver.ts) takes
// copies only: a copy into NET:/<board> queues the files for the board's Amiga. SERVER ONLY.
import { parsePath, type FsPath } from './path';
import { driverFor } from './drivers';
import {
  groupBy, refuse, Refused, REMOVE_FAILED,
  type Added, type CopyMove, type FsCtx, type IncomingTop, type OnClash, type OpCtx, type OpItem, type Outcome, type VolumeDriver,
} from './driver';
import { NET_MOVE_IN } from './net-rules';
import { addDiskImages } from './add-to-library';
import { deleteOnShelf, fileOnShelf, makeCollection, renameOnShelf, shelfDest, shelfItem } from './shelf';
import type { Refusal } from './types';
import type { OpVersion } from './edit-rules';

export { keepBothName } from './driver';
export type { OpItem } from './driver';

export type OpRequest =
  | { op: 'copy' | 'move'; sources: string[]; dest: string; onClash: OnClash }
  | { op: 'delete'; sources: string[] }
  | { op: 'makedir'; dest: string; name: string }
  | { op: 'rename'; source: string; name: string }
  | { op: 'protect'; sources: string[]; protection: number }      // AmigaDOS bits, 0..0xff, as files/[block] PATCH takes
  | { op: 'comment'; source: string; comment: string }
  | { op: 'add-to-library'; sources: string[] };                  // STASH: disk images into the library (R8)
export type OpResult =
  /** `versions`: each history version the op saved, in the order it saved them (Undo needs exactly one, Task 9b). */
  | ({ kind: 'done'; items: OpItem[]; added?: Added[]; queued?: number } & { versions: OpVersion[] })
  | Extract<Outcome, { kind: 'clashes' }>
  | { kind: 'refused'; refusal: Refusal; status: number };

export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult> {
  const run: OpCtx = { ...ctx, versions: [] };
  try {
    const r = await dispatch(run, req);
    // `written` is the engine's own business (crossDevice); the caller hears items, what was added, and the versions.
    if (r.kind !== 'done') return r;
    return { kind: 'done', items: r.items, ...(r.added ? { added: r.added } : {}), ...(r.queued !== undefined ? { queued: r.queued } : {}),
      versions: run.versions };
  } catch (e) {
    if (e instanceof Refused) return { kind: 'refused', refusal: e.refusal, status: e.status };
    throw e;
  }
}

function pathOf(raw: string): FsPath {
  const p = parsePath(raw);
  if (!p) refuse('not_found', 404);
  return p;
}
function driverOf(p: FsPath): VolumeDriver {
  const d = driverFor(p.device);
  if (!d) refuse('unsupported', 400, `${p.device}: is not available yet`);
  return d;
}
/** A driver method, or the refusal that its device cannot be changed that way. */
function need<K extends keyof VolumeDriver>(d: VolumeDriver, k: K): NonNullable<VolumeDriver[K]> {
  const f = d[k];
  if (!f) refuse('read_only', 409, `${d.device}: cannot be changed that way`);
  return f as NonNullable<VolumeDriver[K]>;
}

async function dispatch(ctx: OpCtx, req: OpRequest): Promise<Outcome> {
  switch (req.op) {
    case 'copy': case 'move': {
      const dest = pathOf(req.dest);
      // LIBRARY: above the disks (the root, a collection, a title's disk list): filing, not a write (Files 2 §3.2).
      const shelf = await shelfDest(ctx, dest);
      if (shelf) return fileOnShelf(ctx, req as CopyMove, shelf);
      const dd = driverOf(dest);
      const srcs = req.sources.map(pathOf); srcs.forEach(driverOf);
      // C16: a send never takes the original away; Move into NET: is offered nowhere, and the engine says why.
      if (req.op === 'move' && dest.device === 'NET') refuse('unsupported', 400, NET_MOVE_IN);
      if (srcs.every((s) => s.device === dest.device)) return (need(dd, 'within') as NonNullable<VolumeDriver['within']>).call(dd, ctx, req as CopyMove);
      return crossDevice(ctx, req, srcs, dest);
    }
    case 'delete': {
      // A collection, title or disk row among them: the shelf answers for every source, per item.
      for (const s of req.sources) if (await shelfItem(ctx, pathOf(s))) return deleteOnShelf(ctx, req.sources);
      return perDevice(req.sources, (d, s) => (need(d, 'remove') as NonNullable<VolumeDriver['remove']>).call(d, ctx, s));
    }
    case 'protect': return perDevice(req.sources, (d, s) => (need(d, 'setMeta') as NonNullable<VolumeDriver['setMeta']>).call(d, ctx, s, { protection: req.protection }));
    case 'comment': {
      const d = driverOf(pathOf(req.source));
      return (need(d, 'setMeta') as NonNullable<VolumeDriver['setMeta']>).call(d, ctx, [req.source], { comment: req.comment });
    }
    case 'rename': {
      const at = await shelfItem(ctx, pathOf(req.source));
      if (at) return renameOnShelf(ctx, req.source, at, req.name);
      const d = driverOf(pathOf(req.source));
      return (need(d, 'rename') as NonNullable<VolumeDriver['rename']>).call(d, ctx, req.source, req.name);
    }
    case 'makedir': {
      const p = pathOf(req.dest);
      const shelf = await shelfDest(ctx, p);
      if (shelf) return makeCollection(ctx, shelf, req.name);
      const d = driverOf(p);
      return (need(d, 'makedir') as NonNullable<VolumeDriver['makedir']>).call(d, ctx, p, req.name);
    }
    case 'add-to-library': { const r = await addDiskImages(ctx, req.sources); return { kind: 'done', ...r }; }
  }
}

/** Sources grouped by device, one driver call per device; one device: its refusal is the op's, several: per item. */
async function perDevice(sources: string[], run: (d: VolumeDriver, s: string[]) => Promise<Outcome>): Promise<Outcome> {
  const groups = new Map<VolumeDriver, string[]>();
  for (const raw of sources) {
    const d = driverOf(pathOf(raw));
    groups.set(d, [...(groups.get(d) ?? []), raw]);
  }
  if (groups.size === 1) return run([...groups.keys()][0], sources);
  const results = new Map<string, OpItem>();
  for (const [d, list] of groups) {
    try {
      const o = await run(d, list);
      if (o.kind !== 'done') refuse('failed', 500, 'unexpected answer');
      for (const it of o.items) results.set(it.source, it);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      for (const s of list) results.set(s, { source: s, ok: false, refusal: e.refusal });
    }
  }
  return { kind: 'done', items: sources.map((s) => results.get(s)!) };
}

/**
 * Copy or move between devices: every source collected, then ONE write into the destination. A move then removes,
 * per device, only the sources the writer reports it wrote (ruling 1: a skipped or refused one keeps its original),
 * and each only while it is still exactly what was collected.
 */
async function crossDevice(ctx: OpCtx, req: CopyMove, srcs: FsPath[], dest: FsPath): Promise<Outcome> {
  const dd = driverOf(dest);
  const write = need(dd, 'write') as NonNullable<VolumeDriver['write']>;
  const tops: IncomingTop[] = [];
  for (const [i, p] of srcs.entries()) {
    const items = await driverOf(p).collect(ctx, p);
    if (!items) refuse('not_found', 404);
    tops.push({ source: req.sources[i], items });
  }
  if (req.op === 'move') {
    // Every source must be removable BEFORE the destination is written (a held disk, an archive member, a file still
    // arriving): a move refused afterwards would leave a copy the person did not ask for.
    for (const [device, list] of groupBy(req.sources, (s) => pathOf(s).device)) {
      const d = driverFor(device)!;
      need(d, 'remove');
      await (need(d, 'mustRemove') as NonNullable<VolumeDriver['mustRemove']>).call(d, ctx, list);
    }
  }
  const out = await write.call(dd, ctx, dest, tops, req.onClash);
  if (out.kind !== 'done' || req.op !== 'move') return out;
  const written = new Set(out.written ?? []);
  const moved = req.sources.filter((s) => written.has(s));
  const results = new Map(out.items.map((x) => [x.source, x] as const));
  for (const [device, list] of groupBy(moved, (s) => pathOf(s).device)) {
    const d = driverFor(device)!;
    const unchanged = new Map(tops.filter((t) => list.includes(t.source)).map((t) => [t.source, t.items] as const));
    try {
      const r = await d.remove!(ctx, list, unchanged);
      if (r.kind === 'done') {
        for (const x of r.items) if (!x.ok) results.set(x.source, { source: x.source, ok: false, refusal: { code: x.refusal.code, detail: REMOVE_FAILED } });
      }
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      for (const s of list) results.set(s, { source: s, ok: false, refusal: { code: e.refusal.code, detail: REMOVE_FAILED } });
    }
  }
  return { kind: 'done', items: req.sources.map((s) => results.get(s)!) };
}
