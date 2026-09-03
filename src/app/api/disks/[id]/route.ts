import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { deleteDisk } from '@/lib/disk-delete';

export const maxDuration = 60;

const patchBody = z.object({ writeProtected: z.boolean() });

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  // Org-scoped in the statement, not in a WHERE a later edit could drop.
  const updated = await getDb().update(disks)
    .set({ writeProtected: parsed.data.writeProtected })
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .returning({ id: disks.id, writeProtected: disks.writeProtected });

  if (updated.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(updated[0]);
}

/**
 * Remove one disk. Takes the title with it when it was the last one, since a
 * title with no disks is not a title.
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const result = await deleteDisk(orgId, id);
  if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(result);
}
