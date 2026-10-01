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
import { blobs } from '@/db/schema/catalog';
import { bumpVolumeDate } from './volume-date';

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
// The source image's blob row, as restore's identity lookup reads it, and
// every blob row the batch inserted (so a test can see what identity the
// restored image was given).
let identityResult: unknown[] = [];
let insertedBlobs: Record<string, unknown>[] = [];
// When set, findHolder's nth query answers `holderByCall[n - 1]` instead of
// `holderResult` -- how a scenario makes a board MOUNT BETWEEN restore's two
// holder checks (nothing held it when the read began; something does by the
// time the record is about to happen).
let holderByCall: (unknown[] | undefined)[] | null = null;
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
    let table: unknown = null;
    const chain = {
      from: (t: unknown) => { table = t; return chain; },
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
        if (table === blobs) return Promise.resolve(identityResult);
        if (!joined) {
          holderLimitCalls++;
          if (holderByCall) return Promise.resolve(holderByCall[holderLimitCalls - 1] ?? []);
        }
        return Promise.resolve(joined ? diskLookupResult : holderResult);
      },
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      const stmt = {
        __apply: () => {
          if (table === blobs) insertedBlobs.push(row);
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
  identityResult = [];
  insertedBlobs = [];
  holderByCall = null;
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

    // The older image comes back with only its volume date moved (volume-date.ts).
    const restored = bumpVolumeDate(images[targetSeq], [images[headSeq]])!;
    expect(result).toEqual({ ok: true, sha256: sha256Of(restored), seq: headSeq + 1, recorded: true });

    // History GREW: every prior row is still there, unchanged...
    for (const before of rowsBefore) {
      const still = diskVersionRows.find((r) => r.seq === before.seq);
      expect(still).toEqual(before);
    }
    // ...plus exactly one new row, recorded as a rewind of the target seq,
    // whose image is the OLDER version's image (re-dated), not a copy of the old head.
    expect(diskVersionRows).toHaveLength(rowsBefore.length + 1);
    const newRow = diskVersionRows.find((r) => r.seq === headSeq + 1);
    expect(newRow).toMatchObject({
      source: 'rewind', rewindOf: targetSeq, imageSha256: sha256Of(restored),
    });
  });

  it('restoring the head records nothing and answers ok with the current sha and seq', async () => {
    const images = await buildChain(['A', 'B']); // versions 0..2
    const headSeq = images.length - 1;

    diskLookupResult = [{ sha256: sha256Of(images[headSeq]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, headSeq, null);

    // `recorded: false` is the difference the panel needs: the disk holds
    // that version's bytes, but nothing was written, so telling someone
    // "Restored" would describe an event that did not happen.
    expect(result).toEqual({ ok: true, sha256: sha256Of(images[headSeq]), seq: headSeq, recorded: false });
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

  it('refuses a board that mounts DURING the read, and records nothing', async () => {
    // THE WINDOW THIS CLOSES: the first holder check runs before
    // `materialise`, which is up to 65 sequential blob reads. A board that
    // mounts inside that window opens a write session, and closeSession
    // deliberately lets an ALREADY OPEN session outlive a version bump
    // (device-write.ts) -- so repointLateMounts would not stop the Amiga's
    // save landing on top of this rewind, while the person who clicked
    // Restore was told it worked. Nothing held the disk when the read began;
    // something does by the time the record would happen.
    const images = await buildChain(['A', 'B']);
    diskLookupResult = [{ sha256: sha256Of(images[2]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    holderByCall = [[], [{ name: 'Amiga 500 #1' }]];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 0, 'user-1');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(409);
    expect(result.reason).toContain('Amiga 500 #1');
    // The refusal is the point, but so is WHERE it happened: both checks ran,
    // and no version was recorded despite the first one passing.
    expect(holderLimitCalls).toBe(2);
    expect(diskVersionRows).toHaveLength(rowCountBefore);
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

  it('refuses a target whose size differs from the head, recording nothing (Review Focus 5)', async () => {
    await buildChain(['A']);   // DD versions 0..1
    // The head the disk row points at is an HD image: only reachable by a
    // hand-edited row or blob, and it must be a refusal, never a 500.
    const hdHead = formatVolume({ filesystem: 'FFS', volumeName: 'Other', density: 'hd' });
    blobBytes.set(sha256Of(hdHead), hdHead);
    diskLookupResult = [{ sha256: sha256Of(hdHead), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rowCountBefore = diskVersionRows.length;

    const { restoreVersion } = await import('./restore');
    expect(await restoreVersion(ORG, DISK, 0, null)).toEqual({ ok: false, status: 409, reason: 'size_mismatch' });
    expect(diskVersionRows).toHaveLength(rowCountBefore);
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

  it('restores an HD version like a DD one (HD writes spec §5.2)', async () => {
    const { recordVersion } = await import('./store');
    let head = formatVolume({ filesystem: 'FFS', volumeName: 'HDChain', density: 'hd' });
    blobBytes.set(sha256Of(head), head);
    const images = [head];
    for (const name of ['A', 'B']) {
      const r = addFile(head, 1760, name, new TextEncoder().encode(name));
      if (!r.ok) throw new Error(`fixture: ${r.reason}`);
      await recordVersion({
        orgId: ORG, diskId: DISK, headSha: sha256Of(head), head, next: r.adf,
        source: 'browser', userId: 'user-1', sourceFilename: 'HDChain.adf',
      });
      head = r.adf;
      images.push(head);
    }
    diskLookupResult = [{
      sha256: sha256Of(images[2]), tosecName: 'HDChain.adf', sourceFilename: 'HDChain.adf',
      imageFormat: 'adf', sizeBytes: 1_802_240,
    }];

    const { restoreVersion } = await import('./restore');
    expect(await restoreVersion(ORG, DISK, 1, 'user-2'))
      .toEqual({ ok: true, sha256: sha256Of(bumpVolumeDate(images[1], [images[2]])!), seq: 3, recorded: true });
  });

  it('gives the restored image the identity of the version it came from', async () => {
    const images = await buildChain(['A', 'B']);
    diskLookupResult = [{ sha256: sha256Of(images[2]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const checked = new Date('2026-09-01T00:00:00Z');
    identityResult = [{
      tosecEntryId: 'tosec-1', matchState: 'matched', matchCheckedAt: checked,
      openretroEntryId: 'or-1', enrichState: 'enriched', enrichCheckedAt: checked,
    }];

    const { restoreVersion } = await import('./restore');
    const result = await restoreVersion(ORG, DISK, 0, 'user-2');
    expect(result.ok && result.recorded).toBe(true);

    const restored = sha256Of(bumpVolumeDate(images[0], [images[2]])!);
    expect(insertedBlobs.find((b) => b.sha256 === restored)).toMatchObject(identityResult[0] as object);
  });

  it('restores a disk with no AmigaDOS volume byte for byte, and carries no identity', async () => {
    const { recordVersion } = await import('./store');
    const v0 = new Uint8Array(901_120).fill(0x4e); // no 'DOS' boot block: a trackloader-style disk
    const v1 = v0.slice(); v1[5000] = 1;
    blobBytes.set(sha256Of(v0), v0);
    await recordVersion({
      orgId: ORG, diskId: DISK, headSha: sha256Of(v0), head: v0, next: v1,
      source: 'browser', userId: 'user-1', sourceFilename: 'Game.adf',
    });
    diskLookupResult = [{ sha256: sha256Of(v1), tosecName: 'Game.adf', sourceFilename: 'Game.adf' }];
    identityResult = [{ matchState: 'matched', tosecEntryId: 'tosec-1' }];

    const { restoreVersion } = await import('./restore');
    expect(await restoreVersion(ORG, DISK, 0, 'user-2'))
      .toEqual({ ok: true, sha256: sha256Of(v0), seq: 2, recorded: true });
    const row = insertedBlobs.find((b) => b.sha256 === sha256Of(v0));
    expect(row?.matchState).toBeUndefined();
  });

  it('restoring the same version again, with nothing written since, records nothing', async () => {
    const images = await buildChain(['A', 'B']);
    diskLookupResult = [{ sha256: sha256Of(images[2]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const { restoreVersion } = await import('./restore');
    const first = await restoreVersion(ORG, DISK, 0, 'user-2');
    if (!first.ok) throw new Error('fixture: first restore');

    diskLookupResult = [{ sha256: first.sha256, tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const rows = diskVersionRows.length;
    expect(await restoreVersion(ORG, DISK, 0, 'user-2'))
      .toEqual({ ok: true, sha256: first.sha256, seq: first.seq, recorded: false });
    expect(diskVersionRows).toHaveLength(rows);
  });

  it('a later restore goes past the date an earlier one issued, even when the head has no volume', async () => {
    const { recordVersion } = await import('./store');
    const images = await buildChain(['A']);
    diskLookupResult = [{ sha256: sha256Of(images[1]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const { restoreVersion } = await import('./restore');
    const first = await restoreVersion(ORG, DISK, 0, 'user-2');
    if (!first.ok) throw new Error('fixture: first restore');
    const firstImage = blobBytes.get(first.sha256)!;

    // The Amiga overwrites the disk with something that has no volume at all
    // (a trackloader copy): the head no longer carries the issued date.
    const ndos = firstImage.slice(); ndos[0] = 0x4e;
    await recordVersion({
      orgId: ORG, diskId: DISK, headSha: first.sha256, head: firstImage, next: ndos,
      source: 'amiga', sourceFilename: 'Chain.adf',
    });
    diskLookupResult = [{ sha256: sha256Of(ndos), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];

    const second = await restoreVersion(ORG, DISK, 0, 'user-2');
    if (!second.ok) throw new Error('second restore');
    // Not the first restore's date again: one tick past it.
    expect(second.sha256).toBe(sha256Of(bumpVolumeDate(images[0], [firstImage])!));
    expect(second.sha256).not.toBe(first.sha256);
  });

  it('records where a re-dated copy came from, and flattens a copy of a copy to the original', async () => {
    const images = await buildChain(['A']);
    diskLookupResult = [{ sha256: sha256Of(images[1]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const { restoreVersion } = await import('./restore');
    const first = await restoreVersion(ORG, DISK, 0, 'user-2');
    if (!first.ok) throw new Error('fixture');
    expect(insertedBlobs.find((b) => b.sha256 === first.sha256)?.derivedFromSha256).toBe(sha256Of(images[0]));

    // Restore version 1, then restore version 2 (itself a copy of version 0):
    // the new copy points at version 0's image, not at version 2's.
    diskLookupResult = [{ sha256: first.sha256, tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const back = await restoreVersion(ORG, DISK, 1, 'user-2');
    if (!back.ok) throw new Error('fixture');
    diskLookupResult = [{ sha256: back.sha256, tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    identityResult = [{ derivedFromSha256: sha256Of(images[0]), matchState: 'matched' }];
    const again = await restoreVersion(ORG, DISK, first.seq, 'user-2');
    if (!again.ok) throw new Error('restore of a copy');
    expect(insertedBlobs.find((b) => b.sha256 === again.sha256)?.derivedFromSha256).toBe(sha256Of(images[0]));
  });

  it('a byte-for-byte restore in between does not hide the date an earlier restore issued', async () => {
    const { recordVersion } = await import('./store');
    const images = await buildChain(['A']);
    diskLookupResult = [{ sha256: sha256Of(images[1]), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const { restoreVersion } = await import('./restore');
    const first = await restoreVersion(ORG, DISK, 0, 'user-2'); // re-dated: D+1
    if (!first.ok) throw new Error('fixture');
    const firstImage = blobBytes.get(first.sha256)!;

    // Two volume-less writes, then a restore of the first of them: a rewind
    // that issued no date, and is now the LATEST rewind.
    const ndosA = firstImage.slice(); ndosA[0] = 0x4e;
    const ndosB = ndosA.slice(); ndosB[7000] ^= 1;
    await recordVersion({ orgId: ORG, diskId: DISK, headSha: first.sha256, head: firstImage, next: ndosA, source: 'amiga', sourceFilename: 'Chain.adf' });
    await recordVersion({ orgId: ORG, diskId: DISK, headSha: sha256Of(ndosA), head: ndosA, next: ndosB, source: 'amiga', sourceFilename: 'Chain.adf' });
    diskLookupResult = [{ sha256: sha256Of(ndosB), tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const ndosSeq = diskVersionRows.find((r) => r.imageSha256 === sha256Of(ndosA))!.seq as number;
    const exact = await restoreVersion(ORG, DISK, ndosSeq, 'user-2');
    if (!exact.ok) throw new Error('fixture');
    expect(exact.sha256).toBe(sha256Of(ndosA)); // no volume: restored byte for byte

    diskLookupResult = [{ sha256: exact.sha256, tosecName: 'Chain.adf', sourceFilename: 'Chain.adf' }];
    const again = await restoreVersion(ORG, DISK, 0, 'user-2');
    if (!again.ok) throw new Error('restore');
    expect(again.sha256).toBe(sha256Of(bumpVolumeDate(images[0], [firstImage])!)); // D+2, not D+1
  });
});
