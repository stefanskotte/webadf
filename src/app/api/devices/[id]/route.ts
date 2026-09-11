import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { renameDevice } from '@/lib/device-name';

export const maxDuration = 60;

// Empty is ALLOWED and means "reset to the default label" -- see renameDevice.
// 80 matches the collection rename bound; devices.name is unbounded text, so
// this is the only thing standing between a paste and a card that cannot be
// read. Trimmed before length is judged, so 80 spaces is an empty alias rather
// than a maximum-length one.
const renameBody = z.object({ alias: z.string().trim().max(80) });

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

  // 404 rather than 403 for a device outside this org: a caller learns nothing
  // about whether the id exists, matching /api/device/image's boundary.
  const renamed = await renameDevice(orgId, id, parsed.data.alias);
  if (!renamed) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true });
}
