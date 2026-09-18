import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { closeSession, SESSION_TOKEN } from '@/lib/device-write';

export const maxDuration = 60;

const query = z.object({
  disk: z.string().min(1).max(64),
  mount: z.coerce.number().int().nonnegative(),
  session: z.string().regex(SESSION_TOKEN),
  seq: z.coerce.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  const out = await closeSession(device,
    { diskId: q.data.disk, mount: q.data.mount, seq: q.data.seq, sha256: q.data.sha256, session: q.data.session });
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
