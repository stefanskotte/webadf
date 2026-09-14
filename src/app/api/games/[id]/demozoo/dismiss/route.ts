import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { dismissDemozoo } from '@/lib/demozoo/apply';

export const maxDuration = 60;

const body = z.object({ productionId: z.number().int().positive() });

/** Not this: remembered for this org's game, so the suggestion does not come back. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  if (!(await dismissDemozoo(orgId, id, parsed.data.productionId))) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ ok: true });
}
