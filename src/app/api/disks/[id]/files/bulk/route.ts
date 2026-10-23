import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { readVolume, deleteEntry, moveEntry, type WriteResult } from '@/lib/adffs';
import { applyDiskEdit } from '@/lib/disk-write';
import { findEntry, findEntryWithParent, underSelected } from '@/lib/disk-entries';

export const maxDuration = 60;

const blocks = z.array(z.number().int().nonnegative()).min(1).max(1000);
const body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('delete'), blocks }),
  z.object({ op: z.literal('move'), blocks, toParent: z.number().int().nonnegative() }),
]);

/**
 * Delete or move several entries in ONE commit (A5's multi-select): one new
 * version for the whole action, so one Undo (a restore of the version before
 * it) puts every entry back. All or nothing -- the edit runs on a copy, and
 * any entry that cannot go refuses the lot.
 *
 * Every block is resolved through the parsed tree of the bytes being edited,
 * the same rule files/[block] follows. An entry inside a folder that is also
 * selected goes with that folder rather than on its own; a move leaves an
 * entry already in the destination where it is.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }
  const req = parsed.data;
  const selected = new Set(req.blocks);

  const edit = (adf: Uint8Array): WriteResult => {
    const first = readVolume(adf);
    if (!first.ok) return { ok: false, reason: 'no-filesystem' };
    if (req.op === 'move' && req.toParent !== first.rootBlock) {
      const dest = findEntry(first.root, req.toParent);
      if (!dest) return { ok: false, reason: 'not-found' };
      if (dest.kind !== 'dir') return { ok: false, reason: 'not-a-directory' };
    }
    const todo = [...selected].filter((b) => !underSelected(first.root, b, selected));

    let cur = adf;
    for (const block of todo) {
      // Re-read each time: an earlier step may have relinked a hash chain
      // this entry's predecessor lives in.
      const volume = readVolume(cur);
      if (!volume.ok) return { ok: false, reason: 'no-filesystem' };
      const found = findEntryWithParent(volume.root, block, volume.rootBlock);
      if (!found) return { ok: false, reason: 'not-found' };
      let step: WriteResult;
      if (req.op === 'delete') {
        step = deleteEntry(cur, found.parentBlock, block);
      } else {
        if (found.parentBlock === req.toParent) continue;
        step = moveEntry(cur, found.parentBlock, block, req.toParent);
      }
      if (!step.ok) return step;
      cur = step.adf;
    }
    return { ok: true, adf: cur };
  };

  const result = await applyDiskEdit(orgId, id, edit, userId);
  if (!result.ok) {
    const reason = result.reason === 'cycle' ? 'a folder cannot be moved inside itself' : result.reason;
    return Response.json({ error: 'edit_failed', reason }, { status: result.status });
  }
  return Response.json({ id, sha256: result.sha256, seq: result.seq });
}
