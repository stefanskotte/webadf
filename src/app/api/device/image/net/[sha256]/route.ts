import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { writeWfadDd } from '@/lib/adfmfm';
import { servedWithoutEntitlement } from '@/lib/paulanet-disk';

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
 * No entitlement: the driver disk is a fixed image owned by no organization, and this route serves THAT digest
 * and nothing else. Any other digest is 404, the same answer the library route gives a disk the board's
 * organization does not own -- so this route is never a way around that boundary. Same device authentication
 * as the library route.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ sha256: string }> },
) {
  try {
    await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { sha256 } = await ctx.params;
  if (!servedWithoutEntitlement(sha256)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
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
    // The pinned digest names a 901,120-byte ADF, so this means a corrupt store object: permanent, not a
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
