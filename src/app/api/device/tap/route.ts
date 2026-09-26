import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { tapDevice } from '@/lib/nfc/store';
import { DISK_ID_RE } from '@/lib/nfc/rules';

export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store' };
const body = z.object({ diskId: z.string().regex(DISK_ID_RE) });

/** A tag read on the board (spec 2026-09-25 §5.2). Always 200 with an outcome:
 *  a 404 for a disk would tell a foreign id from an unknown one (D4). */
export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  const result = await tapDevice(device.deviceId, device.orgId, parsed.data.diskId, new Date());
  return Response.json(result, { headers: NO_STORE });
}
