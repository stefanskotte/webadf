import { describe, it, expect, vi, beforeEach } from 'vitest';

// Files increment 1, Task 9 (R3): the versionless Browse address lands on Files with the disk in the right pane; a
// `?version=` (the History's per-version view) is still this page.
const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); });
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); });
vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'o1', userId: 'u1' }) }));
const libraryDiskOf = vi.fn();
vi.mock('@/lib/files/disk-strip-data', () => ({ libraryDiskOf }));
// Past the redirect the page goes on to its own reads; the first of them stops the test there.
const firstCollectionOf = vi.fn();
vi.mock('@/lib/collections', () => ({ listCollections: async () => { throw new Error('PAST_THE_REDIRECT'); }, firstCollectionOf }));

const { default: DiskFilesPage } = await import('./page');

function call(id: string, sp: Record<string, string>) {
  const props = { params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) };
  return DiskFilesPage(props as unknown as Parameters<typeof DiskFilesPage>[0]);
}

describe('/disks/[id]/files redirects to Files (R3)', () => {
  beforeEach(() => { redirect.mockClear(); notFound.mockClear(); libraryDiskOf.mockReset(); firstCollectionOf.mockReset(); firstCollectionOf.mockResolvedValue(null); });

  it('with no version: Files, STASH: on the left, the disk on the right, the right pane active', async () => {
    libraryDiskOf.mockResolvedValue({ gameId: 'g1', imageFormat: 'adf' });
    await expect(call('d1', {})).rejects.toThrow('NEXT_REDIRECT');
    expect(libraryDiskOf).toHaveBeenCalledWith('o1', 'd1');
    expect(redirect).toHaveBeenCalledWith(`/files?left=STASH:&right=${encodeURIComponent('LIBRARY:/g1/d1')}&active=right`);
  });

  it('a filed title\'s disk opens inside its first collection (Files 2 §3.1)', async () => {
    libraryDiskOf.mockResolvedValue({ gameId: 'g1', imageFormat: 'adf' });
    firstCollectionOf.mockResolvedValue('c1');
    await expect(call('d1', {})).rejects.toThrow('NEXT_REDIRECT');
    expect(firstCollectionOf).toHaveBeenCalledWith('o1', 'g1');
    expect(redirect).toHaveBeenCalledWith(`/files?left=STASH:&right=${encodeURIComponent('LIBRARY:/c1/g1/d1')}&active=right`);
  });

  it('an unknown or foreign disk is a 404, as before', async () => {
    libraryDiskOf.mockResolvedValue(null);
    await expect(call('nope', {})).rejects.toThrow('NEXT_NOT_FOUND');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('an HFE has nothing to list: its title page, as before', async () => {
    libraryDiskOf.mockResolvedValue({ gameId: 'g1', imageFormat: 'hfe' });
    await expect(call('d1', {})).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/games/g1');
  });

  it('with ?version=2 the page renders as today: no redirect', async () => {
    await expect(call('d1', { version: '2' })).rejects.toThrow('PAST_THE_REDIRECT');
    expect(redirect).not.toHaveBeenCalled();
    expect(libraryDiskOf).not.toHaveBeenCalled();
  });
});
