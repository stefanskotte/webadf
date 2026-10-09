import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { renameDevice } from '@/lib/device-name';
import { deleteDevice } from '@/lib/device-delete';

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

// Removes the board from this org. Its token dies with the row: on its next
// request the board gets a 401, ejects, forgets the token and offers its setup
// portal again, where a fresh pairing code re-pairs it (device_client.c, main.c).
// 404 for foreign and unknown ids alike, as PATCH above does.
//
// CSRF: relies on Better Auth's SameSite=Lax session cookie, like the sibling
// eject route -- no separate origin check.
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const deleted = await deleteDevice(orgId, id);
  if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true });
}
