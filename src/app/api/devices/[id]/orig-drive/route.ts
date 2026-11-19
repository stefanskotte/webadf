import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveOrigDrive } from '@/lib/orig-drive-store';

const body = z.object({ mode: z.enum(['auto', 'off']) });

// Original drive (src/lib/orig-drive.ts). CSRF: as every device route here, Better Auth's SameSite=Lax session
// cookie (see ../mount/route.ts). Refused for a board without the expander.
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveOrigDrive(orgId, id, parsed.data.mode);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'not_capable') {
    return Response.json({ error: 'not_capable', reason: 'This board has no original drive connector' }, { status: 409 });
  }
  return Response.json({ version: r.version });
}
