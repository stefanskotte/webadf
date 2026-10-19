// runBlobGc end to end against a fake database and store (pre-flight I10): the PaulaNET driver disk is an
// object no row names -- no blobs row, no disk, no entitlement -- so only ALWAYS_REFERENCED_BLOBS keeps it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads } from '@/db/schema/amiga-uploads';

const OLD = new Date('2026-01-01T00:00:00Z');   // far past the week's grace
const ORPHAN = 'e'.repeat(64);
const UPLOADED = 'd'.repeat(64);   // a file an Amiga sent up: only amiga_uploads names it
const QUEUED = 'f'.repeat(64);   // a file waiting to be sent to an Amiga (PaulaNET Phase 4): only transfers names it

// Every select resolves to no rows: `.from()` is awaitable and also offers `.where()` (the cover pass).
const rows = (table?: unknown) => {
  const found = table === transfers ? [{ s: QUEUED }] : table === amigaUploads ? [{ s: UPLOADED }] : [];
  const p = Promise.resolve(found as unknown[]);
  return Object.assign(p, { where: () => Promise.resolve((table === amigaUploads ? found : []) as unknown[]) });
};
const db = {
  select: () => ({ from: rows }),
  selectDistinct: () => ({ from: rows }),
  delete: () => ({ where: async () => undefined }),
};
vi.mock('@/db', () => ({ getDb: () => db }));

const listAll = vi.fn<() => Promise<{ sha256: string; uploadedAt: Date }[]>>();
const remove = vi.fn<(sha: string) => Promise<void>>(async () => undefined);
vi.mock('@/lib/storage', () => ({
  diskStore: { listAll: () => listAll(), remove: (s: string) => remove(s) },
  coverStore: { listAll: async () => [], remove: async () => undefined },
}));

beforeEach(() => {
  vi.clearAllMocks();
  listAll.mockResolvedValue([
    { sha256: PAULANET_DISK_SHA256, uploadedAt: OLD },
    { sha256: ORPHAN, uploadedAt: OLD },
    { sha256: QUEUED, uploadedAt: OLD },
    { sha256: UPLOADED, uploadedAt: OLD },
  ]);
});

describe('runBlobGc keeps the PaulaNET driver disk', () => {
  it('deletes an unnamed old object but never the driver disk, which no row names either', async () => {
    const { runBlobGc } = await import('./blob-gc-run');
    const result = await runBlobGc({ dryRun: false });
    expect(result.refused).toBeNull();
    expect(remove).toHaveBeenCalledWith(ORPHAN);              // the GC really ran and deleted something
    expect(remove).not.toHaveBeenCalledWith(PAULANET_DISK_SHA256);
    expect(result.objects).toBe(1);
  });
  it('keeps a file a transfers row names (queued for an Amiga), however old', async () => {
    const { runBlobGc } = await import('./blob-gc-run');
    await runBlobGc({ dryRun: false });
    expect(remove).not.toHaveBeenCalledWith(QUEUED);
  });
  it('keeps a file an amiga_uploads row names (sent up from an Amiga), however old', async () => {
    const { runBlobGc } = await import('./blob-gc-run');
    await runBlobGc({ dryRun: false });
    expect(remove).not.toHaveBeenCalledWith(UPLOADED);
  });
});
