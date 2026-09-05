import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import {
  readVolume, readFile, deleteEntry, renameEntry, replaceFile, moveEntry,
  type AdfEntry, type WriteResult,
} from '@/lib/adffs';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { downloadFilename, contentDisposition } from '@/lib/download-name';
import { applyDiskEdit } from '@/lib/disk-write';

export const maxDuration = 60;

/** Depth-first search for the entry at `block`, so its NAME can be used. */
function findEntry(entries: AdfEntry[], block: number): AdfEntry | null {
  for (const e of entries) {
    if (e.block === block) return e;
    const found = findEntry(e.children, block);
    if (found) return found;
  }
  return null;
}

/**
 * Same walk as `findEntry`, but also returns the block the entry lives
 * directly under. `renameEntry` and `deleteEntry` both take the PARENT block
 * explicitly (spec D-3-5's block-addressing has no parent pointer of its
 * own to read back), so the only way to get it is to walk down from
 * ROOT_BLOCK and remember where each entry was found.
 */
function findEntryWithParent(
  entries: AdfEntry[], block: number, parentBlock: number,
): { entry: AdfEntry; parentBlock: number } | null {
  for (const e of entries) {
    if (e.block === block) return { entry: e, parentBlock };
    const found = findEntryWithParent(e.children, block, e.block);
    if (found) return found;
  }
  return null;
}

/**
 * One file out of a disk's AmigaDOS filesystem.
 *
 * Addressed by BLOCK NUMBER, not path (design decision D-3-5): the block is
 * the entry's identity inside the image, it needs no escaping, and a path
 * would have to be re-resolved by re-walking the tree anyway.
 *
 * The block is validated by locating it in the parsed tree rather than by
 * trusting the caller -- readFile alone would happily return bytes for any
 * block that merely LOOKS like a file header, including one an attacker
 * pointed at. Walking first also yields the name for Content-Disposition.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; block: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, block } = await ctx.params;

  const blockNo = Number(block);
  if (!Number.isInteger(blockNo) || blockNo < 0) {
    return Response.json({ error: 'bad_block' }, { status: 400 });
  }

  // The same entitlement boundary as /api/disks/[id]/adf. 404, never 403.
  const rows = await getDb()
    .select({ sha256: disks.sha256 })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  let adf: Uint8Array;
  try {
    adf = await diskStore.read(disk.sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  const volume = readVolume(adf);
  if (!volume.ok) return Response.json({ error: 'no_filesystem' }, { status: 404 });

  const entry = findEntry(volume.root, blockNo);
  if (!entry || entry.kind !== 'file') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const content = readFile(adf, blockNo);
  if (!content) return Response.json({ error: 'unreadable' }, { status: 422 });

  // An AmigaDOS filename is as untrusted as an uploaded one: it reaches a
  // response header, so it goes through the same sanitiser, which strips
  // CR/LF and emits the RFC 5987 form.
  // ext '' -- a file inside a disk is not an ADF.
  const name = downloadFilename(entry.name, entry.name, disk.sha256, '');

  return new Response(content.bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(content.bytes.byteLength),
      'content-disposition': contentDisposition(name),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}

const renameBody = z.object({ name: z.string().trim().min(1) });
const moveBody = z.object({ toParent: z.number().int().nonnegative() });

/**
 * Rename this entry, replace a file's contents, or move it to another
 * directory -- distinguished by content type and, within a JSON body, by
 * which field is present. A rename relinks a hash chain and never touches
 * data blocks; a replace never touches the hash chain (D-W-6, the header
 * block IS the file's identity) and only rewrites data; a move relinks the
 * hash chain from one directory into another and touches no data blocks
 * either (design §6). A multipart body carrying a `file` part replaces; a
 * JSON body with `toParent` moves; any other JSON body renames.
 *
 * All three closures walk the tree from the SAME bytes `applyDiskEdit` is
 * about to hash and store, never a separate read: `renameEntry` and
 * `moveEntry` both need the entry's CURRENT parent block, which only that
 * walk can supply.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; block: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, block } = await ctx.params;

  const blockNo = Number(block);
  if (!Number.isInteger(blockNo) || blockNo < 0) {
    return Response.json({ error: 'bad_block' }, { status: 400 });
  }

  const contentType = request.headers.get('content-type') ?? '';
  let edit: (adf: Uint8Array) => WriteResult;

  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return Response.json({ error: 'invalid_body', detail: 'file is required' }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    edit = (adf) => replaceFile(adf, blockNo, bytes);
  } else {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    // `toParent` is the one field that distinguishes a move from a rename --
    // there is no separate `kind` field to fall out of sync with it.
    if (raw !== null && typeof raw === 'object' && 'toParent' in raw) {
      const parsed = moveBody.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
      }
      const toParent = parsed.data.toParent;
      edit = (adf) => {
        const volume = readVolume(adf);
        if (!volume.ok) return { ok: false, reason: 'no-filesystem' };
        const found = findEntryWithParent(volume.root, blockNo, ROOT_BLOCK);
        if (!found) return { ok: false, reason: 'not-found' };
        return moveEntry(adf, found.parentBlock, blockNo, toParent);
      };
    } else {
      const parsed = renameBody.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
      }
      const newName = parsed.data.name;
      edit = (adf) => {
        const volume = readVolume(adf);
        if (!volume.ok) return { ok: false, reason: 'no-filesystem' };
        const found = findEntryWithParent(volume.root, blockNo, ROOT_BLOCK);
        if (!found) return { ok: false, reason: 'not-found' };
        return renameEntry(adf, found.parentBlock, blockNo, newName);
      };
    }
  }

  const result = await applyDiskEdit(orgId, id, edit);
  if (!result.ok) {
    // A bare "cycle" means nothing to a person -- say what it actually
    // means: dragging a folder into its own subtree.
    const reason = result.reason === 'cycle'
      ? 'a folder cannot be moved inside itself'
      : result.reason;
    return Response.json({ error: 'edit_failed', reason }, { status: result.status });
  }
  return Response.json({ id, block: blockNo, sha256: result.sha256 });
}

/**
 * Delete this entry -- a file, or a directory and everything under it
 * (`deleteEntry` is recursive, spec R-4). Same parent-block resolution as
 * the rename branch of PATCH above, against the same freshly-loaded bytes.
 */
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string; block: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, block } = await ctx.params;

  const blockNo = Number(block);
  if (!Number.isInteger(blockNo) || blockNo < 0) {
    return Response.json({ error: 'bad_block' }, { status: 400 });
  }

  const edit = (adf: Uint8Array): WriteResult => {
    const volume = readVolume(adf);
    if (!volume.ok) return { ok: false, reason: 'no-filesystem' };
    const found = findEntryWithParent(volume.root, blockNo, ROOT_BLOCK);
    if (!found) return { ok: false, reason: 'not-found' };
    return deleteEntry(adf, found.parentBlock, blockNo);
  };

  const result = await applyDiskEdit(orgId, id, edit);
  if (!result.ok) {
    return Response.json({ error: 'edit_failed', reason: result.reason }, { status: result.status });
  }
  return Response.json({ id, block: blockNo, sha256: result.sha256 });
}
