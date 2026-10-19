// Add to library (spec 2026-10-18 §4, U6): never automatic. The bytes go through URL ingest's normaliser (ADZ, DMS
// and DMZ become an ADF; an HFE stays as it is) and then registerUploads -- the one code path a browser upload and a
// URL fetch take, so dedupe, the TOSEC sweep and history behave the same (plan ruling P6).
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { getUpload, setLibraryDisk, usableBlob } from '@/lib/amiga-uploads';
import { libraryEligible } from '@/lib/from-amiga-ui';
import { diskStore } from '@/lib/storage';
import { prepareImages } from '@/lib/url-ingest';
import { contentHashes } from '@/lib/content-hashes';
import { registerUploads } from '@/lib/ingest-complete';

export const maxDuration = 60;

async function diskWhere(orgId: string, where: ReturnType<typeof eq>) {
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks).where(and(eq(disks.orgId, orgId), where)).limit(1);
  return d ?? null;
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Outside the try: requireOrg signs a stranger out by throwing Next's redirect, which must reach Next.
  const { orgId } = await requireOrg();
  try {
    return await add(orgId, ctx);
  } catch (err) {
    console.error('uploads: add to library failed', err);
    return Response.json({ error: 'server' }, { status: 500 });
  }
}

async function add(orgId: string, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const row = await getUpload(db, orgId, id);
  const blob = row && usableBlob(row);
  if (!row || !blob) return Response.json({ error: 'not_found' }, { status: 404 });
  if (row.libraryDiskId) {
    const d = await diskWhere(orgId, eq(disks.id, row.libraryDiskId));
    if (d) return Response.json({ diskId: d.id, gameId: d.gameId });
  }
  if (!libraryEligible(row.path, row.sizeBytes)) return Response.json({ error: 'not_a_disk_image' }, { status: 422 });
  let stored: Uint8Array;
  try { stored = await diskStore.read(blob); } catch { return Response.json({ error: 'not_found' }, { status: 404 }); }
  const prepared = await prepareImages(stored, row.path.split(/[/:]/).pop() || 'disk.adf');
  if ('code' in prepared || prepared.images.length === 0) {
    const reason = 'code' in prepared ? undefined : prepared.refused[0]?.note;
    return Response.json({ error: 'not_a_disk_image', ...(reason ? { reason } : {}) }, { status: 422 });
  }
  const img = prepared.images[0];
  const sha256 = contentHashes(img.bytes).sha256;
  if (!(await diskStore.stat(sha256))) await diskStore.put(sha256, img.bytes);
  const res = await registerUploads(orgId, [{ sha256, sizeBytes: img.bytes.byteLength, filename: img.filename }]);
  if (res.status !== 200 && res.status !== 409) return Response.json({ error: 'ingest_failed' }, { status: 502 });
  const out = (await res.json()) as { rejectedReasons?: Record<string, string> };
  const refused = out.rejectedReasons?.[sha256];
  if (refused) return Response.json({ error: 'refused', reason: refused }, { status: 422 });
  const d = await diskWhere(orgId, eq(disks.sha256, sha256));
  if (!d) return Response.json({ error: 'ingest_failed' }, { status: 502 });
  await setLibraryDisk(db, orgId, id, d.id);
  return Response.json({ diskId: d.id, gameId: d.gameId });
}
