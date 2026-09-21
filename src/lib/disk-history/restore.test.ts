// restoreVersion: puts an earlier version back as the disk's CURRENT image,
// as a NEW version (write-back spec D2 -- a rewind ADDS a version, history
// only grows), and refuses while a board holds the disk.
//
// Modelled on disk-write.test.ts's fakes for the entitlement join and the
// device-holder check, combined with disk-history/history.test.ts's approach
// of building REAL history through the real recordVersion/loadEntries/
// materialise, using real disk images from formatVolume/addFile -- never
// hand-invented delta bytes or VersionEntry arrays. The happy path against a
// real database is covered end to end by e2e/disk-history.spec.ts; what is
// proven here is the ORDER (findHolder before anything is read or written)
// and which outcomes recordVersion's and materialise's own refusals become.

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addFile } from '@/lib/adffs';
import { formatVolume } from '@/lib/adffs/format';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { diskVersions } from '@/db/schema/disk-history';

const sha256Of = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- fake diskStore: an in-memory content-addressed map, same shape as
// store.test.ts / history.test.ts's fakes. `read` is a vi.fn() (not a plain
// closure) so tests can prove NEGATIVES with it -- "the disk is held, so no
// blob was ever read" is a claim about a call count, not just an outcome. ----
const blobBytes = new Map<string, Uint8Array>();
const diskStoreRead = vi.fn((sha256: string) => {
  const b = blobBytes.get(sha256);
  if (!b) throw new Error(`fake diskStore: no blob ${sha256}`);
  return Promise.resolve(b);
});
vi.mock('@/lib/storage', () => ({
  diskStore: {
    put: (sha256: string, bytes: Uint8Array) => {
      blobBytes.set(sha256, bytes);
      return Promise.resolve({ key: `adf/${sha256}` });
    },
    read: diskStoreRead,
    storageKey: (sha256: string) => `adf/${sha256}`,
  },
}));

// ---- fake @/db: diskVersions PERSISTS for real (recordVersion and
// loadEntries both read/write it, and materialise replays it), while the
// disks⋈entitlements lookup and the devices holder check answer from
// fixtures each test sets. The three are dispatched by which chain method
// finishes the query: `.orderBy()` only ever terminates loadEntries' own
// diskVersions query; `.innerJoin()` followed by `.limit()` is
// restoreVersion's own entitlement lookup (same shape as applyDiskEdit's);
// a bare `.limit()` with no join is findHolder's devices query.
//
// `orderByCalls` and `holderLimitCalls` count how many times loadEntries and
// findHolder's own query actually ran -- so a test can capture a count
// mid-scenario and later assert it did NOT move, proving an ORDER (nothing
// past the holder check ran) rather than merely an outcome a reordered
// implementation could produce by accident.
let diskVersionRows: Record<string, unknown>[] = [];
let diskLookupResult: unknown[] = [];
let holderResult: unknown[] = [];
let orderByCalls = 0;
let holderLimitCalls = 0;

function project(row: Record<string, unknown>, cols: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) out[key] = row[key];
  return out;
}

function fakeDb() {
  const select = (cols: Record<string, unknown>) => {
    let joined = false;
    const chain = {
      from: () => chain,
      innerJoin: () => { joined = true; return chain; },
      where: () => chain,
      orderBy: () => {
        orderByCalls++;
        return Promise.resolve(
          diskVersionRows.slice()
            .sort((a, b) => (a.seq as number) - (b.seq as number))
            .map((r) => project(r, cols)),
        );
      },
      limit: () => {
        if (!joined) holderLimitCalls++;
        return Promise.resolve(joined ? diskLookupResult : holderResult);
      },
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      const stmt = {
        __apply: () => {
          if (table === diskVersions) {
            diskVersionRows.push({
              deviceId: null, userId: null, rewindOf: null,
              createdAt: new Date(),
              ...row,
            });
          }
        },
      };
      return { ...stmt, onConflictDoNothing: () => stmt };
    },
  });
  const update = () => ({ set: () => ({ where: () => ({ __apply: () => {} }) }) });
  const batch = (stmts: Array<{ __apply: () => void }>) => {
    for (const s of stmts) s.__apply();
    return Promise.resolve([]);
  };
  return { select, insert, update, batch };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

const ORG = 'org-1';
const DISK = 'disk-1';

beforeEach(() => {
  vi.clearAllMocks();
  blobBytes.clear();
  diskVersionRows = [];
  diskLookupResult = [];
  holderResult = [];
  orderByCalls = 0;
  holderLimitCalls = 0;
});

/** Records `names.length` real versions (one file added per version) on top
 *  of a freshly formatted volume, through the REAL recordVersion, and
 *  returns each version's raw image bytes indexed by seq (0 = as formatted). */
async function buildChain(names: string[]) {
  const { recordVersion } = await import('./store');
  const images: Uint8Array[] = [];

  let head = formatVolume({ filesystem: 'FFS', volumeName: 'Chain' });
  blobBytes.set(sha256Of(head), head);
  images.push(head);

  for (const name of names) {
    const result = addFile(head, ROOT_BLOCK, name, new TextEncoder().encode(name));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture: addFile failed');
    await recordVersion({
      orgId: ORG, diskId: DISK,
      headSha: sha256Of(head), head, next: result.adf,
      source: 'browser', userId: 'user-1', sourceFilename: 'Chain.adf',
    });
    head = result.adf;
    images.push(head);
  }
  return images; // images[seq] === the raw bytes recorded as version `seq`
}

describe('restoreVersion', () => {
  it('records an OLDER version as a NEW rewind version, growing history rather than replacing it', async () => {
    const images = await buildChain(['A', 'B', 'C']); // versions 0..3
    const headSeq = images.length - 1; // 3
    const targetSeq = 1;

    diskLookupResult = [{ sha256: sha256Of(images[headSeq]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowsBefore = diskVersionRows.map((r) => ({ ...r }));

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, targetSeq, 'user-2');

    expect(result).toEqual({ ok: true, sha256: sha256Of(images[targetSeq]), seq: headSeq + 1 });

    // History GREW: every prior row is still there, unchanged...
    for (const before of rowsBefore) {
      const still = diskVersionRows.find((r) => r.seq === before.seq);
      expect(still).toEqual(before);
    }
    // ...plus exactly one new row, recorded as a rewind of the target seq,
    // whose image is the OLDER version's image, not a copy of the old head.
    expect(diskVersionRows).toHaveLength(rowsBefore.length + 1);
    const newRow = diskVersionRows.find((r) => r.seq === headSeq + 1);
    expect(newRow).toMatchObject({
      source: 'rewind', rewindOf: targetSeq, imageSha256: sha256Of(images[targetSeq]),
    });
  });

  it('restoring the head records nothing and answers ok with the current sha and seq', async () => {
    const images = await buildChain(['A', 'B']); // versions 0..2
    const headSeq = images.length - 1;

    diskLookupResult = [{ sha256: sha256Of(images[headSeq]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, headSeq, null);

    expect(result).toEqual({ ok: true, sha256: sha256Of(images[headSeq]), seq: headSeq });
    expect(diskVersionRows).toHaveLength(rowCountBefore); // nothing recorded
  });

  it('an unknown seq is 404, and records nothing', async () => {
    const images = await buildChain(['A']);
    diskLookupResult = [{ sha256: sha256Of(images[1]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 999, 'user-1');

    expect(result).toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(diskVersionRows).toHaveLength(rowCountBefore);
  });

  it('a held disk is 409 mounted, and records nothing -- checked before anything is read', async () => {
    const images = await buildChain(['A', 'B']);
    diskLookupResult = [{ sha256: sha256Of(images[2]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    holderResult = [{ name: 'Amiga 500 #1' }];
    const rowCountBefore = diskVersionRows.length;
    // buildChain's own recordVersion calls already ran loadEntries several
    // times; capture the count AFTER fixture setup so the assertion below is
    // about the call under test, not the chain that built it.
    const orderByCallsBefore = orderByCalls;
    diskStoreRead.mockClear();

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 0, 'user-1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(409);
    expect(result.reason).toContain('Amiga 500 #1');
    expect(diskVersionRows).toHaveLength(rowCountBefore);

    // THE OPERATOR'S RULE, turned into something that can fail: a device
    // holding this disk means NOTHING past the holder check ran -- not
    // loadEntries (so not materialise, so not a single chain blob), and not
    // even the current-head blob read. A findHolder call moved to just
    // before recordVersion (still producing the same 409, since the check
    // still runs eventually) would fail these two assertions even though
    // the outcome above is identical.
    expect(orderByCalls).toBe(orderByCallsBefore);
    expect(diskStoreRead).not.toHaveBeenCalled();
  });

  it('returns 404, never 403, for a disk outside this org -- and never consults the holder or the history for it', async () => {
    diskLookupResult = []; // the org-scoped entitlement join finds nothing
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 0, 'user-1');

    expect(result).toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(diskVersionRows).toHaveLength(rowCountBefore);

    // Nothing past the entitlement lookup ran: no holder check, no history
    // read, no blob read -- a diskId this org has no entitlement for is
    // refused before any of that, the same as applyDiskEdit's own 404.
    expect(holderLimitCalls).toBe(0);
    expect(orderByCalls).toBe(0);
    expect(diskStoreRead).not.toHaveBeenCalled();
  });

  it('a StaleHeadError (the head moved under us) surfaces as 409 conflict', async () => {
    const images = await buildChain(['A', 'B']);
    // Simulate another write having moved the disk on: the entitlement
    // lookup answers with a sha that is NOT where diskVersions' history
    // actually ends, exactly like store.test.ts's own stale-head fixture.
    const staleHead = formatVolume({ filesystem: 'FFS', volumeName: 'Stale' });
    blobBytes.set(sha256Of(staleHead), staleHead);
    diskLookupResult = [{ sha256: sha256Of(staleHead), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 0, 'user-1');

    expect(result).toEqual({ ok: false, status: 409, reason: 'conflict' });
    expect(diskVersionRows).toHaveLength(rowCountBefore); // nothing recorded
  });

  it('a broken chain (HistoryError) is a 500, not a silent empty restore', async () => {
    const images = await buildChain(['A', 'B', 'C']); // versions 0..3, seq 1 is a delta
    diskLookupResult = [{ sha256: sha256Of(images[3]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];

    // Corrupt the chain: drop version 1, leaving a gap between the snapshot
    // at 0 and the delta at 2 that replayPlan cannot walk through.
    diskVersionRows = diskVersionRows.filter((r) => r.seq !== 1);
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 2, 'user-1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(500);
    expect(diskVersionRows).toHaveLength(rowCountBefore); // nothing recorded
  });
});
