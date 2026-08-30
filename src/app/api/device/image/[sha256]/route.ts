import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { entitlements } from '@/db/schema/catalog';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { encodeDisk, WFMF_BYTES } from '@/lib/adfmfm';

// Fetch 880 KB from Blob, encode (~10 ms), stream 2,027,536 bytes out.
export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

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
  if (!SHA256_RE.test(sha256)) {
    return Response.json({ error: 'bad_digest' }, { status: 400 });
  }

  // THE boundary. /api/ingest/check is a deliberate global existence oracle
  // (D13), so a digest is not a secret — TOSEC publishes thousands of them.
  // Serving bytes on digest knowledge alone would turn that accepted risk into
  // a live one. The device's own org must hold the entitlement.
  const owned = await getDb()
    .select({ sha256: entitlements.sha256 })
    .from(entitlements)
    .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, sha256)))
    .limit(1);

  // 404, not 403: a caller learns nothing about whether the blob exists.
  if (owned.length === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  let adf: Uint8Array;
  try {
    adf = await diskStore.read(sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  let wfmf: Uint8Array;
  try {
    wfmf = encodeDisk(adf);
  } catch (e) {
    // A stored blob that will not encode is our bug or a corrupt object, not
    // the device's fault -- but it is also never going to start encoding on a
    // retry. setDesired (src/lib/mount.ts) rejects mounting anything but an
    // exact 901,120-byte image, so this path should be unreachable for a
    // freshly mounted disk; it remains here for a disk that became desired
    // before that guard existed. 422, not 500: this is permanent, not
    // transient, and a device must not treat it as a server fault worth
    // retrying.
    return Response.json(
      { error: 'encode_failed', sha256, detail: (e as Error).message },
      { status: 422 },
    );
  }

  return new Response(wfmf as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(WFMF_BYTES),
      'cache-control': 'no-store',
    },
  });
}
