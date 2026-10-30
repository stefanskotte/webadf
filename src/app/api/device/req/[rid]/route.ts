// POST /api/device/req/<rid> -- NET: volumes (spec 2026-10-30 §3, §4.2): one piece of Transfer's answer, as the lines it
// produced. JSON.parse reads the board's \u00XX escapes (amigaJson) once; the lines are Latin-1 text already.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { answerPiece } from '@/lib/remote-requests';

const Body = z.object({
  piece: z.number().int().min(0).max(100_000),
  lines: z.array(z.string().max(640)).max(400),
  last: z.boolean(),
});

export async function POST(request: Request, ctx: { params: Promise<{ rid: string }> }) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const res = deviceAuthResponse(e); if (res) return res; throw e; }
  const { rid } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(rid)) return Response.json({ code: 'gone' }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: 'bad' }, { status: 400 });
  const r = await answerPiece(getDb(), device.deviceId, rid, parsed.data);
  if (r.ok) return new Response(null, { status: 204 });
  const code = r.status === 404 ? 'gone' : r.status === 409 ? 'order' : 'bad';
  return Response.json({ code }, { status: r.status });
}
