// The board's send queue as protocol text (PaulaNET Phase 4, spec 2026-10-16 §2-3): line 1 is NEXT (the file to send
// next, or "NEXT -"), then the LIST block the board forwards to Receive unchanged. Latin-1 bytes, as on the wire.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { sendQueueText } from '@/lib/transfers';

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const text = await sendQueueText(getDb(), device.deviceId);
  return new Response(new Uint8Array(Buffer.from(text, 'latin1')), {
    headers: { 'content-type': 'text/plain; charset=iso-8859-1', 'cache-control': 'no-store' },
  });
}
