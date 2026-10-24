// Delete one file from the From the Amiga area (spec 2026-10-18 §4). Only the session org's rows.
// `?only=receiving` (the Upload page's Stop): only while the file is still arriving; one that finished meanwhile is
// kept and answers 409 not_receiving. Without it, any file of the org goes (the CLI and older callers).
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { deleteUpload, stopUpload } from '@/lib/amiga-uploads';

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (new URL(request.url).searchParams.get('only') === 'receiving') {
    const r = await stopUpload(getDb(), orgId, id);
    if (r === 'not_receiving') return Response.json({ error: 'not_receiving' }, { status: 409 });
    return new Response(null, { status: r === 'stopped' ? 204 : 404 });
  }
  return new Response(null, { status: (await deleteUpload(getDb(), orgId, id)) ? 204 : 404 });
}
