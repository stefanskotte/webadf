import { verifyPassword } from '@/lib/step-up';
import { lockoutRemaining, recordFailure, clearFailures } from '@/lib/step-up-throttle';

/**
 * The step-up password check as a route runs it: throttle, verify, count.
 * Resolves to null when the password is right (and the failure count is
 * cleared), or to the Response the route must return as it is.
 *
 * ONE implementation for every step-up door -- the firmware update
 * (api/devices/firmware-update) and the setting that turns its prompt off
 * (api/me/prefs/firmware-skip-password) -- so the two can never answer a
 * wrong password or a lockout differently, and a guess at either counts
 * against the same per-user tally.
 */
export async function stepUpGate(userId: string, password: string): Promise<Response | null> {
  // Throttled BEFORE the password is even checked. Without this the endpoint
  // is an unlimited oracle for the account's real password, aimed at exactly
  // the attacker step-up exists to stop -- one who already holds the session
  // cookie. better-auth's own limiter lives in its HTTP router and is
  // bypassed by direct auth.api calls.
  const locked = await lockoutRemaining(userId);
  if (locked > 0) {
    return Response.json(
      { error: 'too_many_attempts', retryAfterMs: locked },
      { status: 429, headers: { 'retry-after': String(Math.ceil(locked / 1000)) } },
    );
  }

  // A wrong password must leave no trace beyond the failure count, and reveal
  // nothing else about the request.
  if (!(await verifyPassword(password))) {
    const lockedFor = await recordFailure(userId);
    return Response.json(
      lockedFor > 0
        ? { error: 'too_many_attempts', retryAfterMs: lockedFor }
        : { error: 'bad_password' },
      { status: lockedFor > 0 ? 429 : 401 },
    );
  }
  await clearFailures(userId);
  return null;
}
