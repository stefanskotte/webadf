import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { undoMove, NotFound } from '@/lib/disk-set-store';
import { PlanError } from '@/lib/disk-set';
import { refuseHidden } from '@/lib/remote-hidden';

const snapshot = z.object({
  diskIds: z.array(z.string().min(1).max(64)).min(1).max(64)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate disk ids'),
  title: z.string().min(1).max(200),
  // No sortTitle: the store derives it from title. A snapshot from before
  // this change still carries one; zod strips it.
  year: z.number().int().min(1900).max(2100).nullable(),
  publisher: z.string().max(200).nullable(),
  metadataSource: z.string().max(32).nullable(),
  // Absent in a snapshot issued before it was carried: treated as not arranged.
  diskOrderSource: z.enum(['human']).nullable().default(null),
  hadExtras: z.boolean(),
});
const body = z.object({ snapshot });

/**
 * Undo an add (disk-sets spec §4): recreate the source title from the snapshot
 * the add returned and move its disks back. Covers, Demozoo links and
 * collection memberships are not restored (the client says so when hadExtras).
 * [id] must be one of the snapshot's disks.
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
  if (!parsed.data.snapshot.diskIds.includes(id)) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    // The recreated title's id, so the client can go back to it.
    const { gameId } = await undoMove(orgId, parsed.data.snapshot);
    return Response.json({ gameId });
  } catch (err) {
    if (err instanceof NotFound) return Response.json({ error: 'not_found' }, { status: 404 });
    // The set changed since the add (disks split up, or the set would be
    // emptied): refused, nothing written.
    if (err instanceof PlanError) return Response.json({ error: err.code }, { status: 409 });
    throw err;
  }
}
