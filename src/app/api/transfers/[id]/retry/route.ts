// Retry one failed or expired file (R10): queued again as a new row; the failed row stays as history.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { retryTransfer } from '@/lib/transfers';
import { queueResponse } from '@/lib/send-http';

export const maxDuration = 60;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;
  const r = await retryTransfer(getDb(), { orgId, userId, id });
  if (!r.ok && r.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (!r.ok && r.reason === 'not_finished') return Response.json({ error: 'not_finished' }, { status: 409 });
  return queueResponse(r as Exclude<typeof r, { ok: false; reason: 'not_found' | 'not_finished' }>);
}
