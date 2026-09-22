import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Failed step-up password attempts, per user.
 *
 * This exists because the step-up check is otherwise an unlimited password
 * oracle. better-auth's own rate limiter runs inside its HTTP router and is
 * bypassed by every direct `auth.api.*` call, and this app has no rate
 * limiting of its own -- so the control added to defend against a stolen
 * session cookie was, against exactly that attacker, a clean 401-vs-200
 * signal they could hammer at full speed until the operator's real password
 * fell out. People reuse passwords; the recovered secret is worth more
 * outside this app than inside it.
 *
 * Per user rather than per IP: the attacker already holds the session, so
 * the account is the thing being attacked and the thing worth protecting. It
 * does mean an attacker can lock the operator out of *updating firmware* for
 * the window, which is the right trade -- denying an update is recoverable,
 * leaking the password is not.
 */
export const stepUpAttempts = pgTable('step_up_attempts', {
  userId: text('user_id').primaryKey(),
  /** Consecutive failures. Reset to 0 on success. */
  failures: integer('failures').notNull().default(0),
  /** While in the future, every attempt is refused without checking. */
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
});
