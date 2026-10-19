// One chunk of an upload from the Amiga (spec 2026-10-18 §4): ?offset=, a raw body of 1..16,384 bytes. Equal to what
// the server has: stored. Below it: a retry, answered with what it has. Above it: 409 -- the board cannot fill a gap,
// so it ends the file and the next PUT resumes.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { storeChunk } from '@/lib/amiga-uploads';
import { recordSendRx } from '@/lib/transfers';
import { readCapped } from '@/lib/read-capped';
import { UPLOAD_CHUNK } from '@/lib/amiga-upload-limits';

export const maxDuration = 60;

const int = (v: string | null) => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null);

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const { id } = await ctx.params;
  const offset = int(new URL(request.url).searchParams.get('offset'));
  if (offset === null) return Response.json({ code: 'server' }, { status: 400 });
  const data = await readCapped(request, UPLOAD_CHUNK);
  if (!data || data.byteLength === 0) return Response.json({ code: 'server' }, { status: 400 });
  const db = getDb();
  const r = await storeChunk(db, device.deviceId, id, offset, data);
  // A board posting chunks is talking to Receive and skips its polls meanwhile: keep "Receive is running" fresh, as
  // the send chunk route does (recordSendRx writes on a change or after 30 s).
  await recordSendRx(db, device.deviceId, 'c');
  if (r.ok) return Response.json({ received: r.received }, { headers: { 'cache-control': 'no-store' } });
  if (r.status === 409) return Response.json({ received: r.received }, { status: 409 });
  if (r.status === 404) return Response.json({ code: 'gone' }, { status: 404 });
  return Response.json({ code: 'server' }, { status: 400 });
}
