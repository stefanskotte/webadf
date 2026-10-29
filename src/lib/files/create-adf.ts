// src/lib/files/create-adf.ts
// Create ADF… in Files (Files 2 §4): a blank image `<Name>.adf` into a STASH: folder (through the STASH: store, so it
// counts toward the org's 500 files / 256 MB and follows the clash setting), or a new title with one blank disk into
// LIBRARY: or a collection. Never in NET:, a title's disk list, a disk or an archive. SERVER ONLY.
import { formatVolume } from '@/lib/adffs/format';
import { createBlankDisk } from '@/lib/blank-disk';
import { parsePath } from './path';
import { libPath, placeInLibrary, titleExists } from './library-paths';
import { writeStash } from './stash-driver';
import { checkName, refuse, type OnClash, type OpCtx, type Outcome } from './driver';
import { GO_UP, NOT_ON_NET } from './shelf-rules';

export type CreateAdfRequest = { dest: string; name: string; filesystem: 'OFS' | 'FFS'; density: 'dd' | 'hd'; onClash: OnClash };
/** The source a STASH: write reports a made image under, before it has a path (and when it is skipped). */
export const CREATED = 'create-adf';

export async function createAdf(ctx: OpCtx, req: CreateAdfRequest): Promise<Outcome> {
  checkName(req.name);   // R7: an AmigaDOS volume name, in STASH: and LIBRARY: alike
  const p = parsePath(req.dest);
  if (!p) refuse('not_found', 404);
  if (p.device === 'NET') refuse('unsupported', 400, NOT_ON_NET);
  if (p.device === 'STASH') {
    const bytes = formatVolume({ filesystem: req.filesystem, volumeName: req.name, density: req.density });
    // writeStash refuses an archive folder (read_only "archive") and a full STASH: (stash_full) before storing a byte.
    const out = await writeStash(ctx, p, [{ source: CREATED, items: [{ rel: [`${req.name}.adf`], kind: 'file', bytes, date: new Date(), protection: 0, comment: null }] }],
      req.onClash, 'copy');
    if (out.kind !== 'done') return out;
    const at = out.placed?.[0]?.path;
    return { kind: 'done', items: out.items.map((i) => (at && i.ok && !i.skipped ? { ...i, source: at } : i)) };
  }
  const at = await placeInLibrary(ctx, p.segments);
  if (!at) refuse('not_found', 404);
  // A foreign or deleted collection id reads as a title id: no such title is not found, not "go up" (§7).
  if (at.level === 'title' && !(await titleExists(ctx, at.gameId))) refuse('not_found', 404);
  if (at.level === 'title' || at.level === 'disk') refuse('unsupported', 400, GO_UP);
  const made = await createBlankDisk(ctx.orgId, { volumeName: req.name, filesystem: req.filesystem, density: req.density,
    collectionId: at.level === 'collection' ? at.collection.id : null, mustFile: true });
  if (!made) refuse('not_found', 404);
  const path = libPath(...at.prefix, made.gameId);
  return { kind: 'done', items: [{ source: path, ok: true }], added: [{ source: path, gameId: made.gameId, diskId: made.diskId }] };
}
