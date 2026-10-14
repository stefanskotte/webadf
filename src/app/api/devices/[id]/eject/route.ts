import { requireOrg } from '@/lib/session';
import { clearDesired } from '@/lib/mount';
import { ejectDf1 } from '@/lib/df1-store';

export const maxDuration = 60;

// CSRF: this route relies entirely on Better Auth's default `SameSite=Lax`
// session cookie -- there is no separate origin check. An unasked eject is
// the one thing spec §1 forbids, and this route is exactly that lever, so if
// `crossSubDomainCookies` or `sameSite:'none'` is ever configured for this
// app, this route needs an explicit origin check added. Not added here;
// comment only.
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  // DF1 any disk (spec 2026-10-14 §3.2): {"drive":"df1"} drops the disk mounted into DF1 and nothing else. No body
  // (every existing caller) or any other body ejects DF0, exactly as before.
  const body = await request.json().catch(() => null) as { drive?: unknown } | null;
  if (body?.drive === 'df1') {
    const v = await ejectDf1(orgId, deviceId);
    if (v === null) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ version: v });
  }

  const version = await clearDesired(orgId, deviceId);
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
