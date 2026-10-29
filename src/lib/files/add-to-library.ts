// src/lib/files/add-to-library.ts
// Add to library (increment 2, R8), shared by the op and by filing onto LIBRARY: (Files 2 R4). SERVER ONLY.
import { parsePath } from './path';
import { refuse, Refused, type Added, type OpCtx, type OpItem } from './driver';
import { stashEntryOf, STILL_ARRIVING } from './stash-driver';
import { addUploadToLibrary } from '@/lib/stash-library';
import { libraryEligible } from '@/lib/from-amiga-ui';

/**
 * Per item: a stored disk image in STASH: itself goes through addUploadToLibrary; nothing else does. `known`: the
 * sources whose disk the library already had (filing onto a collection skips one whose title is there already).
 */
export async function addDiskImages(ctx: OpCtx, sources: string[]): Promise<{ items: OpItem[]; added: Added[]; known: Set<string> }> {
  const items: OpItem[] = [];
  const added: Added[] = [];
  const known = new Set<string>();
  for (const source of sources) {
    try {
      const p = parsePath(source);
      if (!p) refuse('not_found', 404);
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
      if (r.existed) known.add(source);
      items.push({ source, ok: true });
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      items.push({ source, ok: false, refusal: e.refusal });
    }
  }
  return { items, added, known };
}
