import { requireOrg } from '@/lib/session';
import { moveDiskOut, NotFound } from '@/lib/disk-set-store';
import { PlanError } from '@/lib/disk-set';
import { refuseHidden } from '@/lib/remote-hidden';

export const maxDuration = 60;

/**
 * Move disk [id] out of its set into a new one-disk title named after its
 * volume (disk-sets spec §2). Reads the disk's image once, for the name.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const hidden = await refuseHidden(orgId, { diskId: id });
  if (hidden) return hidden;
  if (id.length === 0 || id.length > 64) return Response.json({ error: 'invalid_id' }, { status: 400 });

  try {
    return Response.json(await moveDiskOut(orgId, id));
  } catch (err) {
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    // A lone disk is not in a set; moving it out is refused.
    if (err instanceof PlanError) return Response.json({ error: err.code }, { status: 400 });
    throw err;
  }
}
