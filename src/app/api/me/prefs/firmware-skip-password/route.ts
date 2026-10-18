import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { stepUpGate } from '@/lib/step-up-gate';
import { setUserPrefs } from '@/lib/user-prefs';

/**
 * Turn ON "don't ask for my password when updating board firmware"
 * (UserPrefs.firmware.skipPassword) for the signed-in user only.
 *
 * Password-checked through the SAME gate as the firmware update itself
 * (src/lib/step-up-gate.ts): step-up defends against a stolen session cookie,
 * and a cookie that could switch the prompt off would defeat it. That is why
 * PATCH /api/me/prefs refuses `true`. Turning it OFF goes through that PATCH,
 * with no password.
 *
 *   POST { password } -> 200 full prefs | 400 | 401 bad_password | 429 too_many_attempts
 */
const body = z.object({ password: z.string().min(1).max(200) });

// The password check plus a DB round trip, as in api/devices/firmware-update.
export const maxDuration = 60;

export async function POST(request: Request) {
  const { userId } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  const refused = await stepUpGate(userId, parsed.data.password);
  if (refused) return refused;

  return Response.json(await setUserPrefs(userId, { firmware: { skipPassword: true } }));
}
