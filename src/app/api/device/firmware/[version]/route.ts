import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { firmwareStore } from '@/lib/storage';
import { firmwareVersionSchema, semverOf } from '@/lib/firmware-version';

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
  // Bound AND grammar, both from the shared module. The bound alone let
  // anything under 64 characters reach the database as an equality lookup and
  // come back 404, so the 400 the spec documents was unreachable. semverOf is
  // the grammar the generator produces and the publish rules already enforce;
  // this route takes its version from a URL path segment rather than a JSON
  // body, and it was the one reader checking neither.
  if (!firmwareVersionSchema.safeParse(version).success || semverOf(version) === null) {
    return Response.json({ error: 'bad_version' }, { status: 400, headers: NO_STORE });
  }

  const [rel] = await getDb()
    .select({ blobPath: firmwareReleases.blobPath, sizeBytes: firmwareReleases.sizeBytes })
    .from(firmwareReleases)
    .where(eq(firmwareReleases.version, version))
    .limit(1);

  // 404, not 403: a caller learns nothing about which versions exist.
  if (!rel) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });

  // STREAMED, not buffered. The first version read the whole image into an
  // ArrayBuffer and then copied it again with Buffer.from -- ~3x the image
  // resident per request, at exactly the moment every targeted board asks at
  // once, because the poll releases them all together. content-length comes
  // from the row, which already had it.
  const blob = await firmwareStore.readStream(rel.blobPath).catch(() => null);
  // A row whose object is missing is a 503, not a 404: the release exists and
  // the board should retry, rather than conclude the version is gone and give
  // up on an update it was told to take.
  if (!blob) {
    return Response.json({ error: 'blob_unavailable' }, { status: 503, headers: NO_STORE });
  }

  return new Response(blob.stream, {
    headers: {
      'content-type': 'application/octet-stream',
      // From the object being streamed. Falling back to the row only when the
      // store did not say, so the header can never contradict the body.
      'content-length': String(blob.sizeBytes ?? rel.sizeBytes),
      ...NO_STORE,
    },
  });
}
