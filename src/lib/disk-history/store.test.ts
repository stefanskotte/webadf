// recordVersion's refusals, with the same narrow fakes disk-write.test.ts
// uses: @/db and @/lib/storage are vi.fn()-backed stand-ins. The happy path's
// real DB work is covered end to end by e2e/disk-history.spec.ts; what is
// proven here is the ORDER (a stale head is refused before any PUT) and which
// batch errors become StaleHeadError.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ADF_BYTES } from '@/lib/adfmfm';

const diskStorePut = vi.fn();
vi.mock('@/lib/storage', () => ({
  diskStore: {
    put: diskStorePut,
    storageKey: (sha: string) => `adf/${sha}`,
  },
}));

let historyRows: unknown[] = [];
const batch = vi.fn();

function fakeDb() {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(historyRows),
  };
  const insert = () => ({
    values: () => ({ onConflictDoNothing: () => ({}) }),
  });
  const update = () => ({ set: () => ({ where: () => ({}) }) });
  return { select: () => chain, insert, update, batch };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const H0 = '0'.repeat(64);
const H1 = '1'.repeat(64);

function input() {
  const head = new Uint8Array(ADF_BYTES);
  const next = head.slice();
  next[0] = 1; // one changed sector
  return {
    orgId: 'org-1', diskId: 'disk-1', headSha: H0, head, next,
    source: 'browser' as const, userId: 'user-1', sourceFilename: 'Game.adf',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  historyRows = [];
  batch.mockResolvedValue([]);
});

describe('recordVersion', () => {
  it('refuses a head that is not where history ends, before any PUT', async () => {
    // Another write already moved the disk to H1; this caller read H0.
    historyRows = [
      { seq: 0, kind: 'snapshot', blobSha256: H0, imageSha256: H0 },
      { seq: 1, kind: 'delta', blobSha256: 'd'.repeat(64), imageSha256: H1 },
    ];
    const { recordVersion, StaleHeadError } = await import('./store');

    await expect(recordVersion(input())).rejects.toBeInstanceOf(StaleHeadError);
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('records on top of a head that IS where history ends', async () => {
    historyRows = [{ seq: 0, kind: 'snapshot', blobSha256: H0, imageSha256: H0 }];
    const { recordVersion } = await import('./store');

    const recorded = await recordVersion(input());
    expect(recorded?.seq).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('turns a (disk_id, seq) unique violation from the batch into StaleHeadError', async () => {
    // neon-http's batch throws the raw NeonDbError: code + constraint on it.
    batch.mockRejectedValue(Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'disk_versions_disk_seq',
    }));
    const { recordVersion, StaleHeadError } = await import('./store');

    await expect(recordVersion(input())).rejects.toBeInstanceOf(StaleHeadError);
  });

  it('also recognises the violation when it arrives wrapped as a cause', async () => {
    const neon = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'disk_versions_disk_seq',
    });
    batch.mockRejectedValue(new Error('Failed query', { cause: neon }));
    const { recordVersion, StaleHeadError } = await import('./store');

    await expect(recordVersion(input())).rejects.toBeInstanceOf(StaleHeadError);
  });

  it('propagates any other batch error unchanged', async () => {
    const other = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'some_other_constraint',
    });
    batch.mockRejectedValueOnce(other);
    const { recordVersion } = await import('./store');
    await expect(recordVersion(input())).rejects.toBe(other);

    const down = new Error('connection refused');
    batch.mockRejectedValueOnce(down);
    await expect(recordVersion(input())).rejects.toBe(down);
  });
});
