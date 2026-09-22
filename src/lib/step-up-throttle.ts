import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { stepUpAttempts } from '@/db/schema/step-up';

/**
 * How many consecutive wrong passwords before the door closes, and for how
 * long. Deliberately small: a human who has mistyped five times in a row is
 * not about to get it right on the sixth, and every attempt past that is
 * worth more to an attacker than to them.
 */
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Milliseconds remaining on a lockout, or 0 when the user may try. */
export async function lockoutRemaining(userId: string, now = Date.now()): Promise<number> {
  const [row] = await getDb()
    .select({ lockedUntil: stepUpAttempts.lockedUntil })
    .from(stepUpAttempts)
    .where(eq(stepUpAttempts.userId, userId))
    .limit(1);
  if (!row?.lockedUntil) return 0;
  return Math.max(0, row.lockedUntil.getTime() - now);
}

/**
 * Record a wrong password. Returns the lockout now in force, in ms.
 *
 * The count and the lock are computed in ONE statement against the row's own
 * pre-image, so two attempts racing cannot each read "4" and both decide not
 * to lock.
 */
export async function recordFailure(userId: string, now = Date.now()): Promise<number> {
  const next = sql`${stepUpAttempts.failures} + 1`;
  const [row] = await getDb()
    .insert(stepUpAttempts)
    .values({ userId, failures: 1, lastFailedAt: new Date(now) })
    .onConflictDoUpdate({
      target: stepUpAttempts.userId,
      set: {
        failures: next,
        lastFailedAt: new Date(now),
        lockedUntil: sql`case when ${next} >= ${MAX_FAILURES}
                         then ${new Date(now + LOCKOUT_MS)}::timestamptz
                         else ${stepUpAttempts.lockedUntil} end`,
      },
    })
    .returning({ lockedUntil: stepUpAttempts.lockedUntil });
  if (!row?.lockedUntil) return 0;
  return Math.max(0, row.lockedUntil.getTime() - now);
}

/** A correct password clears the slate. */
export async function clearFailures(userId: string): Promise<void> {
  await getDb()
    .insert(stepUpAttempts)
    .values({ userId, failures: 0, lockedUntil: null })
    .onConflictDoUpdate({
      target: stepUpAttempts.userId,
      set: { failures: 0, lockedUntil: null },
    });
}
