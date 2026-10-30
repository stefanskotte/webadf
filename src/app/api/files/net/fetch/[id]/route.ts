// GET /api/files/net/fetch/<id> -- a copy out of a NET: volume, as it goes (spec 2026-10-30 §4.5): how many files of it
// arrived, failed (and why) or still wait, and where the arrived ones are in STASH:. This org's copies only; else 404.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { fetchProgress } from '@/lib/files/net-fetch';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const p = await fetchProgress(getDb(), orgId, id, new Date());
  if (!p) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(p, { headers: { 'cache-control': 'no-store' } });
}
