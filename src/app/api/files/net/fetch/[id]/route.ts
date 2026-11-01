// GET /api/files/net/fetch/<id> -- a copy out of a NET: volume, as it goes (spec 2026-10-30 §4.5): how many files of it
// arrived, failed (and why) or still wait, and where the arrived ones are in STASH:. This org's copies only; else 404.
// `job`: the same job as GET /api/files/jobs says it (spec 2026-11-01-progress-panel), however long ago it finished --
// the jobs store asks here for a watched job the listing let go while the tab was hidden.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { fetchProgress } from '@/lib/files/net-fetch';
import { jobView } from '@/lib/files/jobs';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const db = getDb();
  const now = new Date();
  const p = await fetchProgress(db, orgId, id, now);
  if (!p) return Response.json({ error: 'not_found' }, { status: 404 });
  const job = await jobView(db, orgId, id, now, p);
  return Response.json({ ...p, job }, { headers: { 'cache-control': 'no-store' } });
}
