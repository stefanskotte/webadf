// POST /api/files/jobs/<id>/cancel -- Cancel the rest (spec 2026-11-01-progress-panel §6): what of the job has not gone
// is withdrawn or stopped; what arrived stays. This org's jobs only; else 404. Pressing it again cancels nothing more.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { cancelJob } from '@/lib/files/job-cancel';

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const r = await cancelJob(getDb(), orgId, id, new Date());
  if (!r.ok) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(r, { headers: { 'cache-control': 'no-store' } });
}
