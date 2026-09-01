import { requireOrg } from '@/lib/session';
import { removeGameFromCollection } from '@/lib/collections';

export const maxDuration = 60;

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string; gameId: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, gameId } = await ctx.params;

  const removed = await removeGameFromCollection(orgId, id, gameId);
  if (!removed) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true });
}
