// Send a file from the Amiga on to an Amiga (spec 2026-10-18 §4): the same queue as Send to Amiga, the same bytes.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { getUpload, usableBlob } from '@/lib/amiga-uploads';
import { findSendTarget } from '@/lib/send-targets';
import { queueTransferFromBlob } from '@/lib/transfers';
import { queueResponse } from '@/lib/send-http';

const body = z.object({ deviceId: z.string().min(1).max(100) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;
  const p = body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const db = getDb();
  const row = await getUpload(db, orgId, id);
  const blob = row && usableBlob(row);
  if (!row || !blob) return Response.json({ error: 'not_found' }, { status: 404 });
  if (!(await findSendTarget(db, orgId, p.data.deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId: p.data.deviceId, userId, path: row.path,
    sha256: blob, protection: row.protection, comment: row.comment }));
}
