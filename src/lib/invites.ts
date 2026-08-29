import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema/devices';

// No O/0, no I/1/L, and NO Q -- see the note on normalizeInviteCode below for
// why Q is excluded from generation even though the reader still maps it.
//
// Exported so device pairing codes (src/lib/invites is the closest thing to a
// "code alphabet" module) are drawn from the exact same unambiguous set --
// a human retypes a pairing code off a screen too, so it deserves the same
// guarantee: no character that a screen font or a squinting eye could
// confuse with another one in the set.
export const ALPHABET = '23456789ABCDEFGHJKMNPRSTUVWXYZ';
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

export type ClaimResult =
  | { ok: true; orgId: string }
  | { ok: false };

/**
 * Atomically claims an invite: the gate ("is this code good?") and the
 * consumption ("mark it used") are the same statement, not two.
 *
 * This replaces an earlier `redeemInvite`, which was a plain SELECT: it
 * checked `consumedAt IS NULL` but never claimed the row, leaving the only
 * write (a conditional UPDATE) to run later in `user.create.after` -- by
 * which point the user row, credential and session already existed. Two
 * concurrent sign-ups carrying the same unconsumed code both passed that
 * SELECT, both got a user created, and only one of the later UPDATEs
 * actually matched a row. One leaked or guessed invite code could therefore
 * mint unboundedly many accounts -- exactly what gating registration exists
 * to prevent.
 *
 * The fix is to fold the check and the write into one round trip: only the
 * caller whose WHERE clause still matches a live, unconsumed, unexpired row
 * gets a result back, and Postgres's own row locking serializes concurrent
 * claims against the same row -- there is no gap between a read and a write
 * for a second caller to land in.
 *
 * The three previously-distinguished failure reasons (`unknown` / `used` /
 * `expired`) collapse into a single failure here on purpose: once the read
 * and the write are the same statement, the caller genuinely cannot tell
 * them apart (a `used` code and an `unknown` one both return zero rows for
 * different reasons), and for an auth gate that is a feature, not a loss --
 * a single "invalid or already used" response leaks nothing about which
 * case applied.
 *
 * There is no user id available to record as `consumedByUserId` here: this
 * runs from `databaseHooks.user.create.before`, and better-auth generates
 * the new user's id later, inside its own adapter's `create()` call, which
 * `createWithHooks` invokes only *after* `before` hooks have already run and
 * returned (verified against better-auth 1.7.1's `@better-auth/core`
 * adapter factory -- id generation happens in `transformInput`, called from
 * that `create()`). So `consumedByUserId` is left null by this call. The
 * security-relevant fact is `consumedAt` being set exactly once, which this
 * statement guarantees; who consumed it is an audit nicety this task
 * doesn't need, and pre-generating a user id solely to attach it here would
 * add real complexity and risk for no correctness benefit.
 */
export async function claimInvite(raw: string): Promise<ClaimResult> {
  const code = normalizeInviteCode(raw);
  const rows = await getDb()
    .update(invites)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(invites.code, code),
      isNull(invites.consumedAt),
      gt(invites.expiresAt, new Date()),
    ))
    .returning({ orgId: invites.orgId });
  const row = rows[0];
  if (!row) return { ok: false };
  return { ok: true, orgId: row.orgId };
}
