import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ getDb: () => { throw new Error('nextStep must not touch the database'); } }));
vi.mock('@/lib/storage', () => ({ demozooExportStore: {} }));

const { nextStep, extractRefusal, REFETCH_AFTER_MS } = await import('./import');

const now = Date.parse('2026-09-20T04:30:00Z');
const cursor = (over: Record<string, unknown>) => ({
  id: 1, step: 'applied', etag: null, lastModified: null, lastAttemptAt: null, fetchedAt: null,
  runStartedAt: null, productionsWritten: 0, screenshotsWritten: 0, appliedAt: null, ...over,
}) as Parameters<typeof nextStep>[0];

describe('nextStep — weekly-at-most fetch, daily resume', () => {
  it('fetches when there has never been an import', () => expect(nextStep(null, now)).toBe('fetch'));

  it('does NOT fetch again within 7 days of the last attempt, even after a failure', () => {
    expect(nextStep(cursor({ lastAttemptAt: new Date(now - REFETCH_AFTER_MS + 60_000) }), now)).toBe('idle');
  });

  it('fetches once 7 days have passed', () => {
    expect(nextStep(cursor({ lastAttemptAt: new Date(now - REFETCH_AFTER_MS) }), now)).toBe('fetch');
  });

  it('resumes extract and write from our copy regardless of the weekly gate', () => {
    const recent = new Date(now - 3_600_000);
    expect(nextStep(cursor({ step: 'fetched', lastAttemptAt: recent }), now)).toBe('extract');
    expect(nextStep(cursor({ step: 'extracted', lastAttemptAt: recent }), now)).toBe('write');
  });

  it('replaces a copy still waiting to be extracted (e.g. refused) with a new fetch once the week has passed', () => {
    expect(nextStep(cursor({ step: 'fetched', lastAttemptAt: new Date(now - REFETCH_AFTER_MS) }), now)).toBe('fetch');
  });
});

describe('extractRefusal — the guard in front of the destructive delete', () => {
  it('refuses an extract that cannot be the Amiga catalogue', () => {
    expect(extractRefusal(0, 0)).toMatch(/fewer than 50000/);
    expect(extractRefusal(49_999, 0)).toMatch(/fewer than 50000/);
  });

  it('refuses an extract that would shrink the held catalogue by more than a fifth', () => {
    expect(extractRefusal(60_000, 78_447)).toMatch(/80% of the 78447 held/);
  });

  it('accepts a first import and an ordinary weekly one', () => {
    expect(extractRefusal(78_447, 0)).toBeNull();
    expect(extractRefusal(78_300, 78_447)).toBeNull();
    expect(extractRefusal(62_758, 78_447)).toBeNull(); // exactly 80%, rounded up
  });
});
