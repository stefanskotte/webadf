import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import { downloadFilename, contentDisposition } from '@/lib/download-name';
import { zipEntries } from '@/lib/disk-zip';
import { refuseHidden } from '@/lib/remote-hidden';

export const maxDuration = 60;

/**
 * Several entries of a disk as one .zip (A5's bulk Download):
 * `?blocks=12,40,881`. Every block is resolved through the parsed tree, the
 * same rule files/[block] follows, and an unknown one fails the whole zip
 * rather than leaving it out silently. A GET with a real URL, so the browser
 * saves it with its own progress, like the single-file download.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const hidden = await refuseHidden(orgId, { diskId: id });
  if (hidden) return hidden;

  const raw = new URL(request.url).searchParams.get('blocks') ?? '';
  const parts = raw.split(',').filter((p) => p !== '');
  const blocks = parts.map(Number);
  if (blocks.length === 0 || blocks.length > 1000 || !parts.every((p) => /^\d+$/.test(p))) {
    return Response.json({ error: 'bad_blocks' }, { status: 400 });
  }

  // The same entitlement boundary as every disk route. 404, never 403.
  const rows = await getDb()
    .select({ sha256: disks.sha256, tosecName: disks.tosecName, sourceFilename: entitlements.sourceFilename })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
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

  const result = zipEntries(adf, volume.root, blocks);
  if (!result.ok && result.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  // The same 422 the single-file download answers for a file it cannot read.
  if (!result.ok) return Response.json({ error: 'unreadable', name: result.name }, { status: 422 });
  const zip = result.zip;

  // "Lemmings (1991).adf" -> "Lemmings (1991) files.zip".
  const base = downloadFilename(disk.tosecName, disk.sourceFilename, disk.sha256, '').replace(/\.(adf|hfe)$/i, '');
  return new Response(zip as unknown as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.byteLength),
      'content-disposition': contentDisposition(`${base} files.zip`),
      'cache-control': 'private, no-store',
    },
  });
}
