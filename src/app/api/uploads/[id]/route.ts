// Delete one file from the From the Amiga area (spec 2026-10-18 §4). Only the session org's rows.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { deleteUpload } from '@/lib/amiga-uploads';

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  return new Response(null, { status: (await deleteUpload(getDb(), orgId, id)) ? 204 : 404 });
}
