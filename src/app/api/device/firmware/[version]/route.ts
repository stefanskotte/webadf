import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { firmwareStore } from '@/lib/storage';
import { FIRMWARE_VERSION_MAX } from '@/lib/firmware-version';

// A .uf2 is ~1 MB. Well inside the default, but stated for the same reason
// the image route states it.
export const maxDuration = 60;

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(
  request: Request,
  ctx: { params: Promise<{ version: string }> },
) {
  try {
    // Authentication IS the boundary here. Unlike the image route there is
    // deliberately NO per-org entitlement check: firmware is a product
    // artifact, global by design (the release registry's D5), and every
    // paired device is entitled to the firmware it has been told to run.
    await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) {
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    throw e;
  }

  const { version } = await ctx.params;
  // Checked before the lookup so a malformed version never reaches the
  // database. FIRMWARE_VERSION_MAX is reused rather than a new literal -- it
  // is the same constant the firmware's own buffer is sized from.
  if (!version || version.length > FIRMWARE_VERSION_MAX) {
    return Response.json({ error: 'bad_version' }, { status: 400, headers: NO_STORE });
  }

  const [rel] = await getDb()
    .select({ blobPath: firmwareReleases.blobPath })
    .from(firmwareReleases)
    .where(eq(firmwareReleases.version, version))
    .limit(1);

  // 404, not 403: a caller learns nothing about which versions exist.
  if (!rel) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });

  const bytes = await firmwareStore.read(rel.blobPath).catch(() => null);
  // A row whose object is missing is a 503, not a 404: the release exists and
  // the board should retry, rather than conclude the version is gone and give
  // up on an update it was told to take.
  if (!bytes) {
    return Response.json({ error: 'blob_unavailable' }, { status: 503, headers: NO_STORE });
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      ...NO_STORE,
    },
  });
}
