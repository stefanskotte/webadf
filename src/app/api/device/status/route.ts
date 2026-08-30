import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { recordStatus } from '@/lib/mount';

export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

const statusBody = z.object({
  // null means "I am holding no disk" — an honest report, not an instruction.
  mountedSha256: z.string().regex(SHA256_RE).nullable(),
  // A UUID naming the exact disks row held, not the sha-keyed blob -- lets
  // recordStatus populate mounted_game_id/mounted_disk_no without a
  // non-unique (orgId, sha256) lookup. No .default(null) here or below: an
  // absent key must parse to `undefined`, not `null`, so recordStatus can
  // tell "not reported" from "explicitly cleared" and leave the column alone
  // rather than wiping it on every partial/heartbeat report.
  mountedDiskId: z.string().min(1).max(64).nullable().optional(),
  // The desired_version this report reflects (spec §4). Optional: older
  // firmware, or a report sent before any version has ever been observed.
  version: z.number().int().nonnegative().optional(),
  error: z.string().max(500).nullable().optional(),
  psramFree: z.number().int().nonnegative().nullable().optional(),
  // Real WiFi RSSI ranges roughly -100..0 dBm, but a marginal link can report
  // well past that before the radio gives up entirely. Widened to -200..20
  // deliberately: telemetry validation must never be able to reject the
  // whole report -- and with it the load-bearing mountedSha256 -- over a
  // signal-strength number nobody acts on precisely.
  rssi: z.number().int().min(-200).max(20).nullable().optional(),
});

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) {
      // A cached 401 served against the wrong bearer would be a cross-tenant
      // leak; no response on this device-facing route may be cached.
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    throw e;
  }

  const body = await readJsonBody(request);
  if (body === null) {
    return Response.json(
      { error: 'invalid_json' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const parsed = statusBody.safeParse(body);
  if (!parsed.success) {
    // { error: 'invalid_body', detail: ... } rather than the flattened object
    // living directly under `error` -- a C client parsing `error` as a string
    // could not otherwise tell this 400 apart from every other error shape
    // in the protocol, all of which put a plain string there.
    return Response.json(
      { error: 'invalid_body', detail: z.flattenError(parsed.error) },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  await recordStatus(device.deviceId, {
    mountedSha256: parsed.data.mountedSha256,
    mountedDiskId: parsed.data.mountedDiskId,
    version: parsed.data.version,
    error: parsed.data.error,
    psramFree: parsed.data.psramFree,
    rssi: parsed.data.rssi,
  });

  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
