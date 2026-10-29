// src/lib/files/ops.ts
// The Files ops engine's front door (spec 2026-10-29 §4): copy, move, delete, makedir, rename, protect, comment and
// Add to library. It sends each op to the driver of the device its paths name (drivers.ts); a device's storage rules
// live in its driver (LIBRARY: library-driver.ts, STASH: stash-driver.ts). A copy or move between devices is collect on
// the source's driver, write on the destination's, then (a move) remove of what was written. SERVER ONLY.
import { parsePath, type FsPath } from './path';
import { driverFor } from './drivers';
import {
  groupBy, refuse, Refused, REMOVE_FAILED,
  type Added, type CopyMove, type FsCtx, type IncomingTop, type OnClash, type OpCtx, type OpItem, type Outcome, type VolumeDriver,
} from './driver';
import { stashEntryOf, STILL_ARRIVING } from './stash-driver';
import { addUploadToLibrary } from '@/lib/stash-library';
import { libraryEligible } from '@/lib/from-amiga-ui';
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
  | ({ kind: 'done'; items: OpItem[]; added?: Added[] } & { versions: OpVersion[] })
  | Extract<Outcome, { kind: 'clashes' }>
  | { kind: 'refused'; refusal: Refusal; status: number };

export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult> {
  const run: OpCtx = { ...ctx, versions: [] };
  try {
    const r = await dispatch(run, req);
    // `written` is the engine's own business (crossDevice); the caller hears items, what was added, and the versions.
    if (r.kind !== 'done') return r;
    return { kind: 'done', items: r.items, ...(r.added ? { added: r.added } : {}), versions: run.versions };
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
      const dest = pathOf(req.dest); const dd = driverOf(dest);
      const srcs = req.sources.map(pathOf); srcs.forEach(driverOf);
      if (srcs.every((s) => s.device === dest.device)) return (need(dd, 'within') as NonNullable<VolumeDriver['within']>).call(dd, ctx, req as CopyMove);
      return crossDevice(ctx, req, srcs, dest);
    }
    case 'delete': return perDevice(req.sources, (d, s) => (need(d, 'remove') as NonNullable<VolumeDriver['remove']>).call(d, ctx, s));
    case 'protect': return perDevice(req.sources, (d, s) => (need(d, 'setMeta') as NonNullable<VolumeDriver['setMeta']>).call(d, ctx, s, { protection: req.protection }));
    case 'comment': {
      const d = driverOf(pathOf(req.source));
      return (need(d, 'setMeta') as NonNullable<VolumeDriver['setMeta']>).call(d, ctx, [req.source], { comment: req.comment });
    }
    case 'rename': {
      const d = driverOf(pathOf(req.source));
      return (need(d, 'rename') as NonNullable<VolumeDriver['rename']>).call(d, ctx, req.source, req.name);
    }
    case 'makedir': {
      const p = pathOf(req.dest); const d = driverOf(p);
      return (need(d, 'makedir') as NonNullable<VolumeDriver['makedir']>).call(d, ctx, p, req.name);
    }
    case 'add-to-library': return addToLibrary(ctx, req.sources);
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
  if (req.op === 'move') for (const p of srcs) need(driverOf(p), 'remove');
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

/** Add to library (R8), per item: a stored disk image in STASH: itself goes through addUploadToLibrary; nothing else does. */
async function addToLibrary(ctx: OpCtx, sources: string[]): Promise<Outcome> {
  const items: OpItem[] = [];
  const added: Added[] = [];
  for (const source of sources) {
    try {
      const p = pathOf(source);
      if (p.device !== 'STASH') refuse('unsupported', 400, 'only files in STASH: are added to the library');
      const at = await stashEntryOf(ctx, p);
      if (!at) refuse('not_found', 404);
      if (at.in === 'archive') refuse('unsupported', 400, 'copy it out of the archive first');
      const row = at.row;
      if (row?.status === 'receiving') refuse('unsupported', 409, STILL_ARRIVING);
      if (!row || row.kind !== 'file') refuse('not_a_disk_image', 422, 'a folder');
      if (row.status !== 'stored') refuse('not_found', 404);
      if (!libraryEligible(row.path, row.sizeBytes)) refuse('not_a_disk_image', 422);
      const r = await addUploadToLibrary(ctx.orgId, row.id);
      if (!r.ok) {
        if (r.error === 'not_found') refuse('not_found', 404);
        if (r.error === 'ingest_failed') refuse('failed', 502, 'the library could not take it');
        refuse('not_a_disk_image', 422, r.reason);
      }
      added.push({ source, gameId: r.gameId, diskId: r.diskId });
      items.push({ source, ok: true });
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      items.push({ source, ok: false, refusal: e.refusal });
    }
  }
  return { kind: 'done', items, added };
}
