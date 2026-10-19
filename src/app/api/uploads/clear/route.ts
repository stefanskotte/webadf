// Clear all (spec 2026-10-18 §4, ruling PF4): every stored or failed file of the org up to `cursor`, the exact
// position of the newest row the person saw (UploadView.cursor) -- a file that arrives while the confirm is open is
// not cleared unseen. A file still arriving stays. With `board` (the list was filtered) only that board's rows go.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { clearUploads, isUploadCursor } from '@/lib/amiga-uploads';

const body = z.object({ cursor: z.string().refine(isUploadCursor), board: z.string().min(1).max(100).optional() });

export async function POST(request: Request) {
  const { orgId } = await requireOrg();
  const p = body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'invalid' }, { status: 400 });
  const deleted = await clearUploads(getDb(), orgId, p.data.cursor, p.data.board ?? null);
  return Response.json({ deleted }, { headers: { 'cache-control': 'no-store' } });
}
