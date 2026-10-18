import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * Per-USER web app preferences (start page, sort orders, ...): one row per
 * user, created on the first save. A missing row means "all defaults".
 *
 * One JSON document rather than a column per setting, so a new view
 * preference needs no migration. Never read raw: src/lib/user-prefs.ts runs
 * every read through parsePrefs (src/lib/user-prefs-schema.ts), which fills
 * defaults and drops anything that no longer validates.
 *
 * Per user, NOT per org: a person who belongs to two organizations keeps one
 * set of preferences. Cascades with the user, so deleting a user (admin
 * delete, the e2e teardown) needs no extra step.
 */
export const userPrefs = pgTable('user_prefs', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  prefs: jsonb('prefs').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
