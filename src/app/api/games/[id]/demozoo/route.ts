import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { confirmDemozoo, unlinkDemozoo } from '@/lib/demozoo/apply';

export const maxDuration = 60;

const body = z.object({ productionId: z.number().int().positive() });

/** Use this: link this org's game to a Demozoo production (org-scoped, spec §6.2). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  if (!(await confirmDemozoo(orgId, id, parsed.data.productionId))) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ ok: true });
}

/** Unlink: clears a confirmation, or hides an automatic link for this org's game. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (!(await unlinkDemozoo(orgId, id))) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ ok: true });
}
