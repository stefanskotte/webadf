import { requireOrg } from '@/lib/session';
import { getUserPrefs, setUserPrefs } from '@/lib/user-prefs';
import { parsePrefsPatch } from '@/lib/user-prefs-schema';

/**
 * The signed-in user's own preferences (src/lib/user-prefs-schema.ts).
 * There is no user id in the path on purpose: a person can only ever read or
 * change their own.
 *
 *   GET   -> the full preferences, defaults filled in
 *   PATCH -> a partial patch ({ library: { sort: { key, dir } } }, ...);
 *            returns the full preferences after it. An unknown setting or a
 *            bad value is a 400 and nothing is stored.
 *            `firmware.skipPassword: true` is a 403 `password_required`
 *            (see firmware-skip-password/route.ts); `false` is fine.
 */
export async function GET() {
  const { userId } = await requireOrg();
  return Response.json(await getUserPrefs(userId));
}

export async function PATCH(request: Request) {
  const { userId } = await requireOrg();

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = parsePrefsPatch(body);
  if (!parsed.ok) return Response.json({ error: 'invalid_body', detail: parsed.error }, { status: 400 });
  // Turning off the firmware password prompt needs the password itself, or a
  // stolen session cookie could flip it and defeat step-up (src/lib/step-up.ts).
  // That is POST /api/me/prefs/firmware-skip-password; turning it OFF is free.
  if (parsed.patch.firmware?.skipPassword === true) {
    return Response.json({ error: 'password_required' }, { status: 403 });
  }

  return Response.json(await setUserPrefs(userId, parsed.patch));
}
