import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { addDisksToSet, NotFound } from '@/lib/disk-set-store';
import { PlanError } from '@/lib/disk-set';
import { refuseHidden } from '@/lib/remote-hidden';

const rename = z.string().trim().min(1).max(80).optional();
/**
 * Either disk ids (each brings its whole title) or whole titles (a library
 * card dropped on a card) -- never both: .strict() refuses the other key.
 */
const body = z.union([
  z.object({ diskIds: z.array(z.string().min(1).max(64)).min(1).max(64), rename }).strict(),
  z.object({ sourceGameIds: z.array(z.string().min(1).max(64)).min(1).max(16), rename }).strict(),
]);

/**
 * Add disks to title [id] (disk-sets spec §4). Each picked disk brings its whole
 * source title; {sourceGameIds} names the source titles directly.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const hidden = await refuseHidden(orgId, { diskId: id });
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
    const pick = 'diskIds' in parsed.data ? parsed.data.diskIds : { sourceGameIds: parsed.data.sourceGameIds };
    const { undo } = await addDisksToSet(orgId, id, pick, parsed.data.rename);
    return Response.json({ undo });
  } catch (err) {
    // Unknown and foreign ids are deliberately indistinguishable.
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    if (err instanceof PlanError) {
      return Response.json({ error: err.code }, { status: err.code === 'stale_order' ? 409 : 400 });
    }
    throw err;
  }
}
