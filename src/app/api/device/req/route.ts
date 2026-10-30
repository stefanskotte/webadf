// GET /api/device/req -- NET: volumes (spec 2026-10-30 §3, §4.2): the board's waiting requests, at most 8, as the
// lines it passes to Transfer (Latin-1). Taking them marks them sent.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { takeWaiting } from '@/lib/remote-requests';
import { requestLine, type RemoteKind } from '@/lib/remote-wire';

export async function GET(request: Request) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const res = deviceAuthResponse(e); if (res) return res; throw e; }
  const rows = await takeWaiting(getDb(), device.deviceId);
  const text = rows.map((r) => requestLine({ id: r.id, kind: r.kind as RemoteKind, amigaPath: r.amigaPath })).join('');
  return new Response(Buffer.from(text, 'latin1'), { headers: { 'content-type': 'text/plain; charset=latin1', 'cache-control': 'no-store' } });
}
