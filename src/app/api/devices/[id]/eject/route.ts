import { requireOrg } from '@/lib/session';
import { clearDesired } from '@/lib/mount';

export const maxDuration = 60;

// CSRF: this route relies entirely on Better Auth's default `SameSite=Lax`
// session cookie -- there is no separate origin check. An unasked eject is
// the one thing spec §1 forbids, and this route is exactly that lever, so if
// `crossSubDomainCookies` or `sameSite:'none'` is ever configured for this
// app, this route needs an explicit origin check added. Not added here;
// comment only.
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  const version = await clearDesired(orgId, deviceId);
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
