import { requireOrg } from '@/lib/session';
import { clearDesired } from '@/lib/mount';

export const maxDuration = 60;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  const version = await clearDesired(orgId, deviceId);
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
