import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { storeWriteResult } from '@/lib/nfc/store';

export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store' };
const body = z.object({
  seq: z.number().int().min(1),
  ok: z.boolean(),
  uid: z.string().min(1).max(32),
  reason: z.string().max(64).optional(),
});

/** The board's read-back of a tag write (spec 2026-09-25 §5.3). The device id
 *  is always the token's, never the body's; storeWriteResult accepts only the
 *  first answer to the current request. */
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
  const stored = await storeWriteResult(device.deviceId, parsed.data);
  return Response.json({ stored }, { headers: NO_STORE });
}
