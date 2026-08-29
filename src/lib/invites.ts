import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema/devices';

// No O/0, no I/1/L, and NO Q -- see the note on normalizeInviteCode below for
// why Q is excluded from generation even though the reader still maps it.
const ALPHABET = '23456789ABCDEFGHJKMNPRSTUVWXYZ';
const CODE_LEN = 8;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Forgiving reader, not a mirror of the generator. It maps `O`/`Q` to `0` and
 * `I`/`L` to `1`, but the generating alphabet contains neither `0` nor `1`
 * (and, deliberately, no `Q` either -- see below). So a code is never
 * ambiguous on issue: a human mistyping `O` or `Q` for what they saw on
 * screen still lands on a character no issued code can contain, and fails as
 * `unknown` rather than silently matching a different invite.
 *
 * `Q` was removed from the generating alphabet (it used to be present)
 * because it collides with the `O -> 0` mapping once normalized: with `Q` in
 * the alphabet, a genuine issued code containing `Q` would normalize to a
 * string containing `0`, which no issued code (drawn from an alphabet with no
 * `0`) could ever equal -- silently making every such code unredeemable.
 * Measured: ~23% of 8-character codes drawn from the old 31-character
 * alphabet contained at least one `Q`. The normalizer keeps the `Q -> 0`
 * mapping regardless, because it must still catch a *typo* of `Q` (e.g. for
 * an `0` the user misread as `Q`) and fail it as `unknown` rather than match.
 */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OQ]/g, '0')
    .replace(/[IL]/g, '1');
}

export async function issueInvite(orgId: string, createdByUserId: string): Promise<string> {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  await getDb().insert(invites).values({
    code, orgId, createdByUserId, expiresAt: new Date(Date.now() + TTL_MS),
  });
  return code;
}

export type RedeemResult =
  | { ok: true; orgId: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

export async function redeemInvite(raw: string): Promise<RedeemResult> {
  const code = normalizeInviteCode(raw);
  const rows = await getDb().select().from(invites).where(eq(invites.code, code)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, orgId: row.orgId };
}
