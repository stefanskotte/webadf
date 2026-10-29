// Add to library (spec 2026-10-18 §4, U6): never automatic. The work is addUploadToLibrary's (src/lib/stash-library.ts),
// which the Files op 'add-to-library' runs too.
import { requireOrg } from '@/lib/session';
import { addUploadToLibrary } from '@/lib/stash-library';

export const maxDuration = 60;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Outside the try: requireOrg signs a stranger out by throwing Next's redirect, which must reach Next.
  const { orgId } = await requireOrg();
  try {
    const { id } = await ctx.params;
    const r = await addUploadToLibrary(orgId, id);
    return r.ok
      ? Response.json({ diskId: r.diskId, gameId: r.gameId })
      : Response.json({ error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, { status: r.status });
  } catch (err) {
    console.error('uploads: add to library failed', err);
    return Response.json({ error: 'server' }, { status: 500 });
  }
}
