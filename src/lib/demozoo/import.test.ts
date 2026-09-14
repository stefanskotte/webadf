import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ getDb: () => { throw new Error('nextStep must not touch the database'); } }));
vi.mock('@/lib/storage', () => ({ demozooExportStore: {} }));

const { nextStep, REFETCH_AFTER_MS } = await import('./import');

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
});
