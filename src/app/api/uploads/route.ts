// The From the Amiga area (spec 2026-10-18 §4, U6): every board's uploads for the session's org, newest first, with
// the org's boards for the filter and their key digits (spec §6).
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listUploads, uploadBoards } from '@/lib/amiga-uploads';

export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const board = new URL(request.url).searchParams.get('board');
  const db = getDb();
  const now = new Date();
  const [rows, boards] = await Promise.all([listUploads(db, orgId, board || null, now), uploadBoards(db, orgId)]);
  return Response.json({ rows, boards, now: now.getTime() }, { headers: { 'cache-control': 'no-store' } });
}
