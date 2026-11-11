import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveDriveBase } from '@/lib/drive-numbers-store';
import type { DriveBase } from '@/lib/drive-numbers';

const body = z.object({ base: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) });

// Drive numbers (src/lib/drive-numbers.ts). CSRF: as every device route here, Better Auth's SameSite=Lax session
// cookie (see ../mount/route.ts). Names the drives only; DF3 also switches the second drive Off.
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveDriveBase(orgId, id, parsed.data.base as DriveBase);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ base: parsed.data.base });
}
