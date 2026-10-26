import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { nowMs } from '@/lib/clock';
import { moveGamesToCollection } from '@/lib/collections';
import { deleteGames } from '@/lib/disk-delete';

export const maxDuration = 60;

const gameIds = z.array(z.string().min(1).max(64)).min(1).max(1000);
const body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), gameIds, to: z.string().min(1), from: z.string().min(1).optional() }),
  z.object({ op: z.literal('delete'), gameIds, dryRun: z.boolean().optional() }),
]);

/**
 * Library multi-select (spec 2026-10-26 §3): move or delete up to 1,000 titles in one request. A static segment
 * beside games/[id], so it wins over the dynamic one; it defines POST only.
 *
 * The org comes from the session, never the body (zod strips unknown keys). Every id is org-checked by the library
 * function in one read; an unknown or foreign id is reported `missing`, never written. A foreign `to`/`from` is 404
 * for the whole move with nothing written (404, never 403). Duplicate ids are dropped here, keeping first order.
 * Both operations are idempotent (Ruling 15), which is what lets the client say "Trying again is safe".
 */
export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }
  const req = parsed.data;
  const ids = [...new Set(req.gameIds)];

  if (req.op === 'move') {
    if (req.from !== undefined && req.from === req.to) {
      return Response.json({ error: 'same_collection' }, { status: 400 });
    }
    const result = await moveGamesToCollection(orgId, ids, req.to, req.from);
    if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(result);
  }

  const now = nowMs();
  return Response.json(req.dryRun
    ? await deleteGames(orgId, ids, { dryRun: true, now })
    : await deleteGames(orgId, ids, { now }));
}
