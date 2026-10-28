// Remove a remote library (spec §4.4): every hidden disk ejected from its drive, then deleted; then the library.
import { requireOrg } from '@/lib/session';
import { removeRemoteLibrary } from '@/lib/remote/store';
import { notFound } from '@/lib/remote/http';

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (!(await removeRemoteLibrary(orgId, id))) return notFound();
  return Response.json({ ok: true });
}
