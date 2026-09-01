import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { reorderCollectionGames } from '@/lib/collections';

export const maxDuration = 60;

const orderBody = z.object({ ids: z.array(z.string().min(1)).max(5000) });

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = orderBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const result = await reorderCollectionGames(orgId, id, parsed.data.ids);

  // null (not this org's collection, or absent) and a { ok: false } reorder
  // error are NOT the same failure -- see reorderCollectionGames' own doc
  // comment. Collapsing them would let another tenant learn "your collection
  // exists" (400) vs "it doesn't" (404) from the status code alone.
  if (result === null) return Response.json({ error: 'not_found' }, { status: 404 });

  if (!result.ok) {
    const error = result.reason === 'unknown-id' ? 'unknown_id'
      : result.reason === 'duplicate-id' ? 'duplicate_id'
      : 'missing_id';
    return Response.json({ error, id: result.id }, { status: 400 });
  }

  return Response.json({ ok: true });
}
