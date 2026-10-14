import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { writeWfadDd, ADF_BYTES } from '@/lib/adfmfm';
import { isStandardDd } from '@/lib/df1-pick';
import { servedWithoutEntitlement } from '@/lib/paulanet-disk';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Reads ~880 KB out of Blob storage and streams ~880 KB out.
export const maxDuration = 60;

/**
 * The PaulaNET driver disk for a board's SLOT_NET (spec 2026-10-12 §2, pre-flight I3). The firmware fetches
 * the `next` it is sent in Network mode from here (device_client.c dc_fetch_into, target SLOT_NET), never from
 * /api/device/image/<sha256>, which keeps serving library disks to DF0 exactly as before.
 *
 * Served as a DD WFAD -- the ADF's sectors behind a 16-byte header naming 11 sectors -- the one container the
 * board accepts into SLOT_NET (image_loader.c; plan ruling 24).
 *
 * No entitlement for the driver disk: a fixed image owned by no organization. Any other digest is 404 unless
 * the board's organization is entitled to it (the same boundary as the library route) -- so this route is never
 * a way around that boundary. Same device authentication as the library route.
 *
 * DF1 any disk (spec 2026-10-14 §4.3): it also serves a disk mounted into DF1 -- a digest the board's OWN
 * organization is entitled to AND has a disk row for as a standard DD ADF (image_format 'adf', exactly 901,120
 * bytes), decided by the row, never by the bytes. Anything else stays 404.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ sha256: string }> },
) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { sha256 } = await ctx.params;
  if (!servedWithoutEntitlement(sha256)) {
    // 404, not 403, throughout: a caller learns nothing about whether the blob exists.
    if (!SHA256_RE.test(sha256)) return Response.json({ error: 'not_found' }, { status: 404 });
    // THE boundary, as on the library route: the device's own org must hold the entitlement.
    const owned = await getDb()
      .select({ sha256: entitlements.sha256 })
      .from(entitlements)
      .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, sha256)))
      .limit(1);
    if (owned.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });
    // And a disk row of that org that is a standard DD ADF.
    const [row] = await getDb()
      .select({ imageFormat: disks.imageFormat, sizeBytes: disks.sizeBytes })
      .from(disks)
      .where(and(
        eq(disks.orgId, device.orgId), eq(disks.sha256, sha256),
        eq(disks.imageFormat, 'adf'), eq(disks.sizeBytes, ADF_BYTES),
      ))
      .limit(1);
    if (!row || !isStandardDd(row)) return Response.json({ error: 'not_found' }, { status: 404 });
  }

  let stored: Uint8Array;
  try {
    stored = await diskStore.read(sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  let body: Uint8Array;
  try {
    body = writeWfadDd(stored);
  } catch (e) {
    // Both kinds are 901,120-byte ADFs by their row, so this means a corrupt store object: permanent, not a
    // server fault worth retrying (the library route's 422 rule).
    return Response.json({ error: 'encode_failed', sha256, detail: (e as Error).message }, { status: 422 });
  }

  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    },
  });
}
