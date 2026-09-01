import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { addGameToCollection } from '@/lib/collections';

export const maxDuration = 60;

const addBody = z.object({ gameId: z.string().min(1) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = addBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  // false covers both "not this org's collection" and "not this org's game" --
  // see addGameToCollection's own doc comment. Either way: 404, never 403.
  const added = await addGameToCollection(orgId, id, parsed.data.gameId);
  if (!added) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true });
}
