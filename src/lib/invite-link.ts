/** The sign-up URL an operator sends along with an invite code. Pure, so it can be tested without a browser. */
export function inviteSignUpUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/sign-up?invite=${encodeURIComponent(code)}`;
}
