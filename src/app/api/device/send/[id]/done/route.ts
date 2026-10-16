// The outcome of one file the board sent to the Amiga (PaulaNET Phase 4): Receive's OK (saved as) or ERR.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { finishTransfer } from '@/lib/transfers';

const body = z.union([
  z.object({ ok: z.literal(true), savedAs: z.string().min(1).max(255) }),
  z.object({ ok: z.literal(false), code: z.string().min(1).max(16), text: z.string().max(200) }),
]);

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
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const done = await finishTransfer(getDb(), device.deviceId, id, p.data);
  // 409: already finished (a repeat after a lost response); the board just refetches the queue.
  return new Response(null, { status: done ? 204 : 409 });
}
