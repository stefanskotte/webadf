// src/lib/files/create-sysconf.ts
// Create SysConf (spec 2026-11-04): DEVS:system-configuration into the active pane, through that place's own write, so
// STASH:'s limits, a disk's history and a volume's job all apply. The settings are checked here, the one gate, so a bad
// request cannot make a bad file. SERVER ONLY.
import { driverFor } from './drivers';
import { refuse, type OnClash, type OpCtx, type Outcome } from './driver';
import { parsePath } from './path';
import { shelfDest } from './shelf';
import { SYSCONF_ON_SHELF } from './shelf-rules';
import { buildSysconf, SYSCONF_NAME, sysconfSchema } from './sysconf';

export type CreateSysconfRequest = { dest: string; settings: unknown; onClash: OnClash };

export async function createSysconf(ctx: OpCtx, req: CreateSysconfRequest): Promise<Outcome> {
  const parsed = sysconfSchema.safeParse(req.settings);
  if (!parsed.success) refuse('unsupported', 400, 'Those settings are not valid');
  const p = parsePath(req.dest);
  if (!p) refuse('not_found', 404);
  if (await shelfDest(ctx, p)) refuse('unsupported', 400, SYSCONF_ON_SHELF);
  const d = driverFor(p.device);
  if (!d?.write) refuse('read_only', 409, `${p.device}: cannot be changed that way`);
  const bytes = buildSysconf(parsed.data);
  return d.write(ctx, p, [{ source: SYSCONF_NAME, items: [{ rel: [SYSCONF_NAME], kind: 'file', bytes, date: new Date(), protection: 0, comment: null }] }], req.onClash);
}
