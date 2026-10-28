// Send a remote disk to the Amiga as <name>.adf (spec §4.2): materialise (owner re-asked), then exactly what
// POST /api/transfers/from-disk {whole:true} does. Body {titleId, deviceId}.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { findSendTarget } from '@/lib/send-targets';
import { queueWholeDiskSend } from '@/lib/send-whole-disk';
import { materialiseRemoteDisk } from '@/lib/remote/materialise';
import { ID_RE, notFound, ownLibrary, remoteFailure } from '@/lib/remote/http';

export const maxDuration = 60;

const body = z.object({ titleId: z.string().regex(ID_RE), deviceId: z.string().min(1).max(64) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string; diskId: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id, diskId } = await ctx.params;
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  if (!ID_RE.test(diskId)) return notFound();
  const { titleId, deviceId } = p.data;

  const lib = await ownLibrary(orgId, id);
  if (!lib) return notFound();
  const db = getDb();
  // Before any fetch, the same answer from-disk gives a board that cannot take files.
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });

  const m = await materialiseRemoteDisk(orgId, id, titleId, diskId);
  if (!m.ok) return remoteFailure(m.reason, lib.host, { disk: true });
  const res = await queueWholeDiskSend(db, orgId, userId, deviceId, m.diskId, { includeHidden: true });
  if (res.status === 404) {
    // A revoke or Remove deleted the row between materialise and the queue (R-7, as for mount).
    const [still] = await db.select({ id: disks.id }).from(disks)
      .where(and(eq(disks.id, m.diskId), eq(disks.orgId, orgId))).limit(1);
    if (!still) return Response.json({ error: 'ended' }, { status: 410 });
  }
  return res;
}
