import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { setDesired } from '@/lib/mount';
import { mountToDf1 } from '@/lib/df1-store';
import { DF1_REFUSAL_TEXT } from '@/lib/df1-pick';
import { TRACK_TOO_LONG } from '@/lib/hfe/messages';
import { HD_UNSUPPORTED } from '@/lib/hd-messages';

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

  if (parsed.data.drive === 'df1') {
    const r = await mountToDf1(orgId, deviceId, parsed.data.diskId);
    if (r.ok) return Response.json({ version: r.version });
    if (r.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
    // Said, not hidden: the reason is the same sentence the disabled button shows (df1-pick.ts).
    return Response.json({ error: r.reason, reason: DF1_REFUSAL_TEXT[r.reason] }, { status: 409 });
  }

  const result = await setDesired(orgId, deviceId, parsed.data.diskId);
  // not_found covers unknown device, unknown disk, and either belonging to
  // another organization — deliberately indistinguishable.
  if (!result.ok && result.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  // HD spec §4.3: the disk is HD and this board's firmware cannot answer the
  // Amiga's drive-ID read as HD. Said, not hidden; the fix is an update.
  if (!result.ok && result.reason === 'hd_unsupported') {
    return Response.json({ error: 'hd_unsupported', reason: HD_UNSUPPORTED }, { status: 409 });
  }
  // Both this org's: the board's firmware cannot hold the disk's longest
  // track. Said, not hidden -- the fix (update the board) is the person's.
  if (!result.ok) return Response.json({ error: 'track_too_long', reason: TRACK_TOO_LONG }, { status: 409 });

  return Response.json({ version: result.version });
}
