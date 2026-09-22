import { auth } from '@/lib/auth';

/**
 * Re-verify the signed-in user's password.
 *
 * What this buys, precisely: it defends against a stolen session cookie --
 * someone with the operator's laptop cannot silently reflash their hardware --
 * and NOTHING else. A compromised server can skip the prompt entirely. It is
 * not a substitute for the image signature.
 *
 * Verified per request rather than by opening an elevated window, so there is
 * no window to time-box, leak, or forget to expire. The 2026-09-13 ruling
 * asked for "minutes, not the session" and "per update rather than once per
 * login"; per request satisfies both more simply than a window does.
 */
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  try {
    // signInEmail mints a session as a side effect. It is inert here: this
    // function returns a boolean, the result is never handed back to the
    // caller, and no Set-Cookie is forwarded -- the caller's existing session
    // is what the surrounding route already authenticated against.
    const result = await auth.api.signInEmail({ body: { email, password } });
    return Boolean(result);
  } catch {
    // better-auth throws APIError on bad credentials. A wrong password is an
    // ordinary answer here, not an exception worth propagating.
    return false;
  }
}
