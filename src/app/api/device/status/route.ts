import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { recordStatus } from '@/lib/mount';

export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

const statusBody = z.object({
  // null means "I am holding no disk" — an honest report, not an instruction.
  mountedSha256: z.string().regex(SHA256_RE).nullable(),
  error: z.string().max(500).nullable().optional().default(null),
  psramFree: z.number().int().nonnegative().nullable().optional().default(null),
  rssi: z.number().int().min(-120).max(0).nullable().optional().default(null),
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
    if (res) return res;
    throw e;
  }

  const body = await readJsonBody(request);
  if (body === null) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const parsed = statusBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  await recordStatus(device.deviceId, {
    mountedSha256: parsed.data.mountedSha256,
    error: parsed.data.error,
    psramFree: parsed.data.psramFree,
    rssi: parsed.data.rssi,
  });

  return new Response(null, { status: 204 });
}
