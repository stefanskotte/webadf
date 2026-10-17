// Cancel one file (spec §4; R9): waiting or moving. A row already finished is 409, so a cancel that loses the race
// with delivery never turns a delivered file into a cancelled one (Review Focus 2).
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { cancelTransfer } from '@/lib/transfers';

export const maxDuration = 60;

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (await cancelTransfer(getDb(), orgId, id)) return Response.json({ ok: true });
  return Response.json({ error: 'not_waiting' }, { status: 409 });
}
