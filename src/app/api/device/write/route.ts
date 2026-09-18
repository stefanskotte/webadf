import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { stageTrack } from '@/lib/device-write';

export const maxDuration = 60;

const query = z.object({
  disk: z.string().min(1).max(64),
  mount: z.coerce.number().int().nonnegative(),
  track: z.coerce.number().int().min(0).max(159),
  seq: z.coerce.number().int().positive(),
});

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) { res.headers.set('cache-control', 'no-store'); return res; }
    throw e;
  }
  const q = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) {
    return Response.json({ error: 'invalid_query', detail: z.flattenError(q.error) },
                         { status: 400, headers: NO_STORE });
  }
  const data = new Uint8Array(await request.arrayBuffer());
  const out = await stageTrack(device,
    { diskId: q.data.disk, mount: q.data.mount, track: q.data.track, seq: q.data.seq }, data);
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
