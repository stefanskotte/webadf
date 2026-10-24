// The upload staging list (spec 2026-10-23): the org's server-side rows (sends and Amiga files) plus the send
// targets (read with one clock, so a row's age and a target's online state agree) and the boards' key digits.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listStaging } from '@/lib/staging-server';
import { listSendTargets } from '@/lib/send-targets';
import { uploadBoards } from '@/lib/amiga-uploads';

export const maxDuration = 60;

export async function GET() {
  const { orgId } = await requireOrg();
  const db = getDb();
  const now = new Date();
  const [rows, targets, boards] = await Promise.all([
    listStaging(db, orgId, now), listSendTargets(db, orgId, now.getTime()), uploadBoards(db, orgId),
  ]);
  return Response.json({ rows, targets, boards, now: now.getTime() }, { headers: { 'cache-control': 'no-store' } });
}
