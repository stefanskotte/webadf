import { randomInt } from 'node:crypto';
import { auth } from '@/lib/auth';

// No I, O, l, 0 or 1: the admin reads this aloud or types it into a chat, and the user types it back.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Four groups of four from a 57-character alphabet: about 93 bits, well above better-auth's 8-character floor. */
export function generateTempPassword(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return [group(), group(), group(), group()].join('-');
}

/**
 * Set `password` on the user's email-and-password account and sign them out everywhere, through better-auth's own
 * hasher and adapter (the same calls its reset-password route makes), so the stored hash is one sign-in can verify.
 *
 * Every session goes: whoever held the account before the reset -- the user, or someone who took it over -- is out.
 * An account with no credential row (none today: sign-up is email and password only) is refused rather than given
 * one, because this route resets a password; it does not add a way in.
 */
export async function resetUserPassword(userId: string, password: string): Promise<'ok' | 'unknown' | 'no_password'> {
  const ctx = await auth.$context;
  const target = await ctx.internalAdapter.findUserById(userId);
  if (!target) return 'unknown';
  if (!(await ctx.internalAdapter.findCredentialAccount(userId))) return 'no_password';
  await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(userId);
  return 'ok';
}
