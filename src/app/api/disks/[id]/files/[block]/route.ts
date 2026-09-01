import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume, readFile, type AdfEntry } from '@/lib/adffs';
import { downloadFilename, contentDisposition } from '@/lib/download-name';

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
