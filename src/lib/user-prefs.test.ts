import { describe, it, expect, vi } from 'vitest';

// A database that cannot answer (the table not migrated yet, a dropped connection).
vi.mock('@/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.reject(new Error('relation "user_prefs" does not exist')) }) }) }),
  }),
}));
const { getUserPrefs } = await import('./user-prefs');
const { DEFAULT_PREFS } = await import('./user-prefs-schema');

describe('getUserPrefs when the read fails', () => {
  it("returns the defaults (today's behaviour) instead of failing the page, and logs once", async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getUserPrefs('u1')).toEqual(DEFAULT_PREFS);
    expect(await getUserPrefs('u2')).toEqual(DEFAULT_PREFS);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
