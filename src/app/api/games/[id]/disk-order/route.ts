import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { reorderSet, NotFound } from '@/lib/disk-set-store';
import { PlanError } from '@/lib/disk-set';
import { refuseHidden } from '@/lib/remote-hidden';

const body = z.object({ diskIds: z.array(z.string().min(1).max(64)).min(1).max(64) });

/**
 * Reorder title [id]'s disks 1..N (disk-sets spec §4). The list must be exactly
 * the title's current disks; anything else was made from a stale page and is 409.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const hidden = await refuseHidden(orgId, { gameId: id });
  if (hidden) return hidden;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  try {
    await reorderSet(orgId, id, parsed.data.diskIds);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    if (err instanceof PlanError) {
      return Response.json({ error: err.code }, { status: err.code === 'stale_order' ? 409 : 400 });
    }
    throw err;
  }
}
