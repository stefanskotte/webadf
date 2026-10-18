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

  return Response.json(await setUserPrefs(userId, parsed.patch));
}
