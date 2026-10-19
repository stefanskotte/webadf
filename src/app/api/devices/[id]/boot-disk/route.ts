import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { saveBootDisk } from '@/lib/boot-disk-store';
import { bootDiskNote } from '@/lib/boot-disk';

const body = z.object({ mode: z.enum(['last', 'empty']) });

// Disk at startup (src/lib/boot-disk.ts). CSRF: as every device route here, Better Auth's SameSite=Lax session cookie
// (see ../mount/route.ts). Nothing is sent to the board: the server applies the setting at the board's next boot.
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await saveBootDisk(orgId, id, parsed.data.mode);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') return Response.json({ error: 'firmware_too_old', reason: bootDiskNote(false) }, { status: 409 });
  return Response.json({ mode: parsed.data.mode });
}
