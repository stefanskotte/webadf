import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { renameCollection, deleteCollection } from '@/lib/collections';

export const maxDuration = 60;

const renameBody = z.object({ name: z.string().trim().min(1).max(80) });

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = renameBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const renamed = await renameCollection(orgId, id, parsed.data.name);
  if (!renamed) return Response.json({ error: 'not_found' }, { status: 404 });
  // Names are unique per library, any case (Files 2 R3).
  if (renamed === 'name_exists') return Response.json({ error: 'name_exists' }, { status: 409 });

  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const deleted = await deleteCollection(orgId, id);
  if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true });
}
