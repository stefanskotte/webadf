import { requireOrg } from '@/lib/session';
import { readVolume, addFile, makeDirectory, type AdfEntry, type WriteResult } from '@/lib/adffs';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { applyDiskEdit } from '@/lib/disk-write';

export const maxDuration = 60;

/**
 * True when `block` is a directory (or the disk's own root) somewhere in
 * this tree -- never trusted as a bare number from the request body. Same
 * doctrine as `GET /api/disks/[id]/files/[block]`'s `findEntry`: the block
 * is validated by locating it in the PARSED tree, because that is the only
 * way to also learn what kind of entry it is.
 */
function isDirectory(entries: AdfEntry[], block: number): boolean {
  for (const e of entries) {
    if (e.block === block) return e.kind === 'dir';
    if (e.kind === 'dir' && isDirectory(e.children, block)) return true;
  }
  return false;
}

/**
 * Add a file, or make a directory, inside an existing disk.
 *
 * One route for both, distinguished by whether the multipart body carries a
 * `file` part: an upload control and a new-folder control naturally post to
 * the same place. Both are a thin `applyDiskEdit` closure over the pure
 * `addFile` / `makeDirectory` in src/lib/adffs/write.ts -- this route does
 * no filesystem mutation itself.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  // `form.get` on a missing field is `null`, and `Number(null)` is `0` --
  // not NaN -- so a dropped field would otherwise silently pass as a request
  // to write into the root directory instead of being rejected. Checked as
  // a string first so "absent" and "present and zero" cannot be confused.
  const parentBlockField = form.get('parentBlock');
  if (typeof parentBlockField !== 'string' || parentBlockField.trim().length === 0) {
    return Response.json({ error: 'bad_parent_block' }, { status: 400 });
  }
  const parentBlock = Number(parentBlockField);
  if (!Number.isInteger(parentBlock) || parentBlock < 0) {
    return Response.json({ error: 'bad_parent_block' }, { status: 400 });
  }

  const nameField = form.get('name');
  if (typeof nameField !== 'string' || nameField.trim().length === 0) {
    return Response.json({ error: 'invalid_body', detail: 'name is required' }, { status: 400 });
  }
  const name = nameField.trim();

  // The presence of a `file` part is what distinguishes an upload from a
  // new-folder request -- there is no separate `kind` field to fall out of
  // sync with it.
  const file = form.get('file');
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : null;

  const edit = (adf: Uint8Array): WriteResult => {
    const volume = readVolume(adf);
    if (!volume.ok) return { ok: false, reason: 'no-filesystem' };
    // ROOT_BLOCK itself is never an entry in `volume.root` -- it IS that
    // array -- so it is accepted without walking for it.
    if (parentBlock !== ROOT_BLOCK && !isDirectory(volume.root, parentBlock)) {
      return { ok: false, reason: 'not-a-directory' };
    }
    return bytes
      ? addFile(adf, parentBlock, name, bytes)
      : makeDirectory(adf, parentBlock, name);
  };

  const result = await applyDiskEdit(orgId, id, edit);
  if (!result.ok) {
    return Response.json({ error: 'edit_failed', reason: result.reason }, { status: result.status });
  }
  return Response.json({ id, sha256: result.sha256 });
}
