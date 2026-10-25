// The sign-in and sign-up error lines (C5 spec §6.3–6.4, Ruling 34): the board's words for the codes this app knows,
// better-auth's own English for any other. Pure and client-safe.

export type AuthErrorLike = { code?: string | null; message?: string | null; status?: number } | null | undefined;

export function authErrorText(kind: 'in' | 'up', error: AuthErrorLike): string {
  if (kind === 'in' && error?.code === 'INVALID_EMAIL_OR_PASSWORD') return 'The email or password is not right.';
  if (kind === 'up' && error?.code === 'INVALID_INVITE_CODE') return 'That invite code is not valid, or it has been used.';
  if (error?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error?.message) return error.message;
  return kind === 'in' ? "Couldn't sign in. Try again." : "Couldn't create the account. Try again.";
}
