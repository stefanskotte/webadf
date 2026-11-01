// GET /api/files/jobs -- the progress panel's jobs (spec 2026-11-01-progress-panel §4): this org's Files jobs that run,
// or finished in the last 2 minutes, with their bytes; one job per board for plain Queue sends. Every page's panel asks.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listJobs } from '@/lib/files/jobs';

export async function GET() {
  const { orgId } = await requireOrg();
  const jobs = await listJobs(getDb(), orgId, new Date());
  return Response.json({ jobs }, { headers: { 'cache-control': 'no-store' } });
}
