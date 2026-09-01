import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { downloadFilename, contentDisposition } from '@/lib/download-name';

// Reads ~880 KB out of Blob storage and streams it back.
export const maxDuration = 60;

/**
 * Download one disk as a raw ADF, for a human.
 *
 * Distinct from /api/device/image/<sha256>, which serves the same disk as
 * MFM-encoded WFMF (~2 MB) to a board. A person wants the 901,120-byte image
 * that other Amiga tools read, so this is a separate route rather than a
 * parameter on that one.
 *
 * THE BOUNDARY IS THE ENTITLEMENT, not the disk row. disks.orgId is an
 * independent column with nothing guaranteeing it matches its game's org --
 * src/lib/admin-delete.ts documents that drift as real -- so the disk lookup
 * being org-scoped is necessary but not sufficient. The entitlement is the
 * tenant's actual proof that they uploaded these bytes, and it is the same
 * check the device route makes.
 *
 * The bytes are STREAMED rather than answered with a redirect to a presigned
 * URL. A presigned URL is a live credential and the standing rule here is
 * that one never reaches the DOM or a log; a redirect would put one in the
 * browser's history for every download.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const rows = await getDb()
    .select({
      sha256: disks.sha256,
      tosecName: disks.tosecName,
      sourceFilename: entitlements.sourceFilename,
    })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  // 404, never 403: the response must not confirm that a disk belonging to
  // another organization exists.
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  let bytes: Uint8Array;
  try {
    bytes = await diskStore.read(disk.sha256);
  } catch {
    // The row exists but the object store could not produce the bytes. That
    // is a real condition here -- the sweeper counts such blobs as
    // `unreadable` -- and it is transient from the caller's point of view.
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  const name = downloadFilename(disk.tosecName, disk.sourceFilename, disk.sha256);

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/x-amiga-disk-file',
      'content-length': String(bytes.byteLength),
      'content-disposition': contentDisposition(name),
      // Content-addressed: these exact bytes never change. Private, because
      // the entitlement check above is per-tenant and a shared cache must
      // not serve them to another organization.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
