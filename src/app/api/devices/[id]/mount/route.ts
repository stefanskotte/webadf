import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { mountDiskResponse } from '@/lib/mount-http';
import { recheckHidden } from '@/lib/remote/remount';

export const maxDuration = 60;

// CSRF: this route relies entirely on Better Auth's default `SameSite=Lax`
// session cookie -- there is no separate origin check. An unasked eject is
// the one thing spec §1 forbids, and this route is the human-facing lever
// that could trigger one, so if `crossSubDomainCookies` or `sameSite:'none'`
// is ever configured for this app, this route needs an explicit origin
// check added. Not added here; comment only.
// `drive` (spec 2026-10-14 §3.3): absent or 'df0' is DF0, exactly as before; 'df1' mounts into DF1.
const mountBody = z.object({ diskId: z.string().min(1).max(64), drive: z.enum(['df0', 'df1']).optional() });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = mountBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  // R-6a: Re-insert and Undo mount by id. A hidden remote disk asks its owner again first, as the remote Mount does.
  const remote = await recheckHidden(orgId, parsed.data.diskId);
  if (remote.hidden && remote.refusal) return remote.refusal;

  return mountDiskResponse(orgId, deviceId, parsed.data.diskId, parsed.data.drive, { hidden: remote.hidden });
}
