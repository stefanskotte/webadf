import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveSecondDrive, SECOND_DRIVE_FW, DF1_SEEN_REASON } from '@/lib/second-drive';

const body = z.object({ mode: z.enum(['off', 'df1']), override: z.boolean().optional() });

// CSRF: as every device route here, Better Auth's SameSite=Lax session cookie (see ../mount/route.ts).
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveSecondDrive(orgId, id, parsed.data.mode, parsed.data.override === true);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') {
    return Response.json({ error: 'firmware_too_old', reason: `Needs firmware ${SECOND_DRIVE_FW} or newer` }, { status: 409 });
  }
  if (r === 'df1_seen') return Response.json({ error: 'df1_seen', reason: DF1_SEEN_REASON }, { status: 409 });
  return Response.json({ version: r.version });
}
