import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { userPrefs } from '@/db/schema/user-prefs';
import { applyPrefsPatch, parsePrefs, type PrefsPatch, type UserPrefs } from '@/lib/user-prefs-schema';

/**
 * The per-user preferences API (server side). The shape, defaults and
 * validation live in src/lib/user-prefs-schema.ts; the browser saves through
 * PATCH /api/me/prefs (savePrefs in src/lib/user-prefs-client.ts).
 *
 *   const prefs = await getUserPrefs(userId);           // always complete
 *   await setUserPrefs(userId, { library: { sort } });  // partial patch
 *
 * `userId` is the signed-in user's own id (requireOrg().userId); nothing here
 * is org-scoped, because preferences belong to the person.
 */

let readFailureLogged = false;

/**
 * This user's preferences, every field filled. A user with no row reads the
 * defaults; nothing is written.
 *
 * A failed read (the table not migrated yet, a dropped connection) also reads
 * the defaults -- today's behaviour -- rather than failing the page: "/" and
 * sign-in, the library, Browse and Settings all call this, and a preference is
 * never worth an error page. Logged once per process, not on every request.
 */
export async function getUserPrefs(userId: string): Promise<UserPrefs> {
  try {
    const rows = await getDb().select({ prefs: userPrefs.prefs }).from(userPrefs)
      .where(eq(userPrefs.userId, userId)).limit(1);
    return parsePrefs(rows[0]?.prefs);
  } catch (err) {
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.error('user prefs: read failed, using defaults', err);
    }
    return parsePrefs(undefined);
  }
}

/**
 * Lay `patch` (already validated: parsePrefsPatch) over this user's stored
 * preferences and return the result.
 *
 * Read-merge-write under a row lock, so two saves landing together (a sort
 * change in one tab, the Preferences form in another) both survive: the row
 * is created first if missing, then locked FOR UPDATE, so the second save
 * merges over the first rather than over the same stale copy. What is stored
 * is the full, normalised document, so a value that had gone invalid is
 * replaced by its default on the next save.
 */
export async function setUserPrefs(userId: string, patch: PrefsPatch): Promise<UserPrefs> {
  return getDb().transaction(async (tx) => {
    await tx.insert(userPrefs).values({ userId }).onConflictDoNothing();
    const [row] = await tx.select({ prefs: userPrefs.prefs }).from(userPrefs)
      .where(eq(userPrefs.userId, userId)).for('update');
    const next = applyPrefsPatch(parsePrefs(row?.prefs), patch);
    await tx.update(userPrefs).set({ prefs: next, updatedAt: new Date() }).where(eq(userPrefs.userId, userId));
    return next;
  });
}
