/**
 * Sending someone back through sign-in and then on to where they were.
 *
 * Better Auth refuses some calls (listSessions) once the session is older than its `freshAge` (default one day),
 * even though the session itself is still valid. Settings uses one, so a person signed in yesterday hit a 500. They
 * now get /sign-in with "Your session has expired" and land back on the page they came from.
 */

/** A same-site path to go to after sign-in; anything else (another host, `//`, `/\`, not a string) becomes `/`. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** Better Auth's APIError for a session too old for the call (`SESSION_NOT_FRESH`). */
export function isSessionNotFresh(err: unknown): boolean {
  const body = (err as { body?: { code?: unknown } } | null)?.body;
  return body?.code === 'SESSION_NOT_FRESH';
}

export function expiredSignInHref(next: string): string {
  return `/sign-in?expired=1&next=${encodeURIComponent(next)}`;
}
