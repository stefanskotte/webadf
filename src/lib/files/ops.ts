// src/lib/files/ops.ts
// The Files ops engine's front door (spec 2026-10-29 §4): copy, move, delete, makedir, rename, protect and comment.
// It sends each op to the driver of the device its paths name (drivers.ts); a device's storage rules live in its driver
// (LIBRARY: library-driver.ts). SERVER ONLY.
import { parsePath, type FsPath } from './path';
import { driverFor } from './drivers';
import {
  refuse, Refused, type CopyMove, type FsCtx, type OnClash, type OpCtx, type OpItem, type Outcome, type VolumeDriver,
} from './driver';
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
  | { op: 'comment'; source: string; comment: string };
export type OpResult =
  /** `versions`: each history version the op saved, in the order it saved them (Undo needs exactly one, Task 9b). */
  | (Extract<Outcome, { kind: 'done' }> & { versions: OpVersion[] })
  | Extract<Outcome, { kind: 'clashes' }>
  | { kind: 'refused'; refusal: Refusal; status: number };

export async function runOp(ctx: FsCtx, req: OpRequest): Promise<OpResult> {
  const run: OpCtx = { ...ctx, versions: [] };
  try {
    const r = await dispatch(run, req);
    return r.kind === 'done' ? { ...r, versions: run.versions } : r;
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

/** Increment 2 Task 5 fills this in; until then a copy between devices is unsupported. */
async function crossDevice(_ctx: OpCtx, _req: CopyMove, _srcs: FsPath[], dest: FsPath): Promise<Outcome> {
  refuse('unsupported', 400, `copying into ${dest.device}: from another device`);
}
