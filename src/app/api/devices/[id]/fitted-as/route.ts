import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveFittedAs } from '@/lib/fitted-as-store';

const body = z.object({ fittedAs: z.enum(['internal', 'external']) });

// Fitted as (src/lib/fitted-as.ts). CSRF: as every device route here, Better Auth's SameSite=Lax session cookie
// (see ../mount/route.ts). Names the drive only; External also switches the second drive Off.
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveFittedAs(orgId, id, parsed.data.fittedAs);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ fittedAs: parsed.data.fittedAs });
}
