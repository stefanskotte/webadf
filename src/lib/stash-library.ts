// Add to library (spec 2026-10-18 §4, U6): never automatic. The bytes go through URL ingest's normaliser (ADZ, DMS
// and DMZ become an ADF; an HFE stays as it is) and then registerUploads -- the one code path a browser upload and a
// URL fetch take, so dedupe, the TOSEC sweep and history behave the same (plan ruling P6). POST /api/uploads/[id]/library
// and the Files op 'add-to-library' (Files spec 2026-10-29, R8) both run it. SERVER ONLY.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { getUpload, setLibraryDisk, usableBlob } from '@/lib/amiga-uploads';
import { libraryEligible } from '@/lib/from-amiga-ui';
import { diskStore } from '@/lib/storage';
import { prepareImages } from '@/lib/url-ingest';
import { storeSendBytes } from '@/lib/send-http';
import { registerUploads } from '@/lib/ingest-complete';
import { isLocal } from '@/lib/remote-hidden';

export type AddToLibraryResult =
  | { ok: true; diskId: string; gameId: string }
  | { ok: false; status: 404 | 422 | 502; error: 'not_found' | 'not_a_disk_image' | 'refused' | 'ingest_failed'; reason?: string };

async function diskWhere(orgId: string, where: ReturnType<typeof eq>) {
  // A local disk only: a hidden remote stand-in with the same bytes (spec §4.1) is not "in the library".
  const [d] = await getDb().select({ id: disks.id, gameId: disks.gameId }).from(disks)
    .where(and(eq(disks.orgId, orgId), isLocal(disks), where)).limit(1);
  return d ?? null;
}

/** The org's stored file `id` (an amiga_uploads row) into the library; a file already added answers its disk again. */
export async function addUploadToLibrary(orgId: string, id: string): Promise<AddToLibraryResult> {
  const db = getDb();
  const row = await getUpload(db, orgId, id);
  const blob = row && usableBlob(row);
  if (!row || !blob) return { ok: false, status: 404, error: 'not_found' };
  if (row.libraryDiskId) {
    const d = await diskWhere(orgId, eq(disks.id, row.libraryDiskId));
    if (d) return { ok: true, diskId: d.id, gameId: d.gameId };
  }
  if (!libraryEligible(row.path, row.sizeBytes)) return { ok: false, status: 422, error: 'not_a_disk_image' };
  let stored: Uint8Array;
  try { stored = await diskStore.read(blob); } catch { return { ok: false, status: 404, error: 'not_found' }; }
  const prepared = await prepareImages(stored, row.path.split(/[/:]/).pop() || 'disk.adf');
  if ('code' in prepared || prepared.images.length === 0) {
    const reason = 'code' in prepared ? undefined : prepared.refused[0]?.note;
    return { ok: false, status: 422, error: 'not_a_disk_image', ...(reason ? { reason } : {}) };
  }
  const img = prepared.images[0];
  // Verified, not trusted by its key: a presigned PUT never committed may have planted other bytes there (storeSendBytes).
  const sha256 = await storeSendBytes(img.bytes);
  const res = await registerUploads(orgId, [{ sha256, sizeBytes: img.bytes.byteLength, filename: img.filename }]);
  if (res.status !== 200 && res.status !== 409) return { ok: false, status: 502, error: 'ingest_failed' };
  const out = (await res.json()) as { rejectedReasons?: Record<string, string> };
  const refused = out.rejectedReasons?.[sha256];
  if (refused) return { ok: false, status: 422, error: 'refused', reason: refused };
  const d = await diskWhere(orgId, eq(disks.sha256, sha256));
  if (!d) return { ok: false, status: 502, error: 'ingest_failed' };
  await setLibraryDisk(db, orgId, id, d.id);
  return { ok: true, diskId: d.id, gameId: d.gameId };
}
