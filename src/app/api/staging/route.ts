// The upload staging list (spec 2026-10-23): the org's server-side rows (sends and Amiga files) plus the send
// targets, read together with one clock so a row's age and a target's online state agree.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listStaging } from '@/lib/staging-server';
import { listSendTargets } from '@/lib/send-targets';

export const maxDuration = 60;

export async function GET() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const now = new Date();
  const [rows, targets] = await Promise.all([listStaging(db, orgId, now), listSendTargets(db, orgId, now.getTime())]);
  return Response.json({ rows, targets, now: now.getTime() }, { headers: { 'cache-control': 'no-store' } });
}
