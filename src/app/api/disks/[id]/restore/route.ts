import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { restoreVersion } from '@/lib/disk-history/restore';
import { isMountedReason } from '@/lib/mount-wording';

export const dynamic = 'force-dynamic';

const body = z.object({ seq: z.number().int().min(0) });

/**
 * Restore a disk to an earlier version -- the time machine's rewind (spec
 * §4). Puts that version's image back as the disk's CURRENT image, recorded
 * as a NEW version (D2: history only grows; nothing between the target and
 * the old head is deleted), and refused while a board holds the disk, same
 * as every other route that rewrites a disk's bytes.
 *
 * All the actual work -- the entitlement boundary, the holder check,
 * replaying the target version and recording the rewind -- lives in
 * `restoreVersion` (src/lib/disk-history/restore.ts); this route only parses
 * the body and maps its outcome to a response, the same division
 * `volume-name/route.ts` uses for the rename.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const result = await restoreVersion(orgId, id, parsed.data.seq, userId);
  if (!result.ok) {
    // A 409 is either a held disk (reason is the shared mountedReason
    // wording) or a stale head (reason is the literal 'conflict'); every
    // other status uses its reason as the error code directly.
    if (result.status === 409 && isMountedReason(result.reason)) {
      return Response.json({ error: 'mounted', reason: result.reason }, { status: 409 });
    }
    return Response.json({ error: result.reason }, { status: result.status });
  }

  return Response.json({ sha256: result.sha256, seq: result.seq });
}
