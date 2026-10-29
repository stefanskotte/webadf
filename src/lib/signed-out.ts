// The signed-out answer an action's fetch gets (moved out of upload-staging.ts for the Files page; CLIENT-SAFE).

/**
 * Signed out, an action's fetch follows requireOrg's redirect and lands on the sign-in page: a 200 that is not JSON.
 * Such an answer is not a success. A redirect is always one; a 204 (no body) is fine; a non-OK answer stays an
 * ordinary failure whatever its type (an HTML 500 or 404 is not a sign-out).
 */
export function isSignedOutAnswer(res: Pick<Response, 'redirected' | 'ok' | 'status' | 'headers'>): boolean {
  if (res.redirected) return true;
  if (!res.ok || res.status === 204) return false;
  return !(res.headers.get('content-type') ?? '').includes('json');
}
export const SIGNED_OUT_TEXT = 'Signed out — sign in again';
