import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

/**
 * Re-verify the signed-in user's password.
 *
 * What this buys, precisely: it defends against a stolen session cookie --
 * someone with the operator's laptop cannot silently reflash their hardware --
 * and NOTHING else. A compromised server can skip the prompt entirely. It is
 * not a substitute for the image signature.
 *
 * USE verifyPassword, NOT signInEmail. The first version of this called
 * `auth.api.signInEmail` for its boolean and claimed in a comment that the
 * session it mints was "inert". Measured, it is not: better-auth persists a
 * real 7-day session row, and `nextCookies()` -- whose after-hook matcher
 * returns true for every path, and whose only escape hatch is a `_flag` that
 * exists solely on the HTTP router path -- forwards its Set-Cookie onto this
 * route's response. So every press of Update silently rotated the operator's
 * session onto a brand-new one and left the old row alive. An attacker
 * holding a stolen, near-expiry cookie who guessed the password was handed a
 * fresh 7-day session BY THE CHECK MEANT TO STOP THEM.
 *
 * `verifyPassword` takes no email: it checks the password of the session's
 * own user, which is what step-up means, and it mints nothing. Both facts
 * were confirmed by running it, not read off the types.
 *
 * NOT SOLVED HERE: this is an unthrottled oracle. better-auth's rate limiter
 * runs in its HTTP router and is bypassed by every direct `auth.api.*` call,
 * and this app has no rate limiting of its own. See the caller.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  try {
    const result = await auth.api.verifyPassword({
      body: { password },
      headers: await headers(),
    });
    return Boolean(result?.status);
  } catch {
    // A wrong password throws BAD_REQUEST/INVALID_PASSWORD; no session means
    // UNAUTHORIZED. Both are ordinary answers here, not exceptions to raise.
    return false;
  }
}
