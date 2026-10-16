// One chunk of a file the board is sending to the Amiga (PaulaNET Phase 4). ?offset=&length= (at most 16 KB); the
// offset doubles as progress, so the board spends no extra request or status bytes reporting it.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { recordChunk, SEND_CHUNK_MAX } from '@/lib/transfers';

export const maxDuration = 60;

const int = (v: string | null) => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null);

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const { id } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const offset = int(q.get('offset'));
  const length = int(q.get('length'));
  if (offset === null || length === null || length === 0 || length > SEND_CHUNK_MAX) {
    return new Response('bad range', { status: 400 });
  }
  const r = await recordChunk(getDb(), device.deviceId, id, offset);
  if (!r.ok) return new Response(null, { status: r.status });
  if (offset >= r.sizeBytes) return new Response('bad range', { status: 400 });
  const bytes = await diskStore.readRange(r.sha256, offset, Math.min(length, r.sizeBytes - offset));
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });
}
