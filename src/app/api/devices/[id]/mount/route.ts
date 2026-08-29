import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { setDesired } from '@/lib/mount';

export const maxDuration = 60;

const mountBody = z.object({ diskId: z.string().min(1).max(64) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = mountBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });

  const version = await setDesired(orgId, deviceId, parsed.data.diskId);
  // null covers unknown device, unknown disk, and either belonging to another
  // organization — deliberately indistinguishable.
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
