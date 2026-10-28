// Mount a remote disk (spec §4.2): re-ask the owner (materialise: uncached, Review Focus 1), hold the bytes as a hidden
// row, then the ordinary mount -- the same JSON as POST /api/devices/[id]/mount. Body {titleId, deviceId, drive}.
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { mountDiskResponse, orgOwnsDevice } from '@/lib/mount-http';
import { materialiseRemoteDisk } from '@/lib/remote/materialise';
import { ID_RE, notFound, ownLibrary, remoteFailure } from '@/lib/remote/http';

export const maxDuration = 60;

const body = z.object({
  titleId: z.string().regex(ID_RE), deviceId: z.string().min(1).max(64), drive: z.enum(['df0', 'df1']).optional(),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string; diskId: string }> }) {
  const { orgId } = await requireOrg();
  const { id, diskId } = await ctx.params;
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  if (!ID_RE.test(diskId)) return notFound();
  const { titleId, deviceId, drive } = p.data;

  const lib = await ownLibrary(orgId, id);
  if (!lib) return notFound();
  // Before any fetch: a board that is not this team's gets nothing downloaded on its behalf.
  if (!(await orgOwnsDevice(orgId, deviceId))) return notFound();

  const m = await materialiseRemoteDisk(orgId, id, titleId, diskId);
  if (!m.ok) return remoteFailure(m.reason, lib.host, { disk: true });
  return mountDiskResponse(orgId, deviceId, m.diskId, drive, { hidden: true });
}
