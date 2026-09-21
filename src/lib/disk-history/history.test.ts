// loadHistory: the list a page renders. Built by actually calling the real
// recordVersion three times (like store.test.ts fakes @/lib/storage, but
// here the fake @/db also PERSISTS rows, since loadHistory has to read back
// what recordVersion wrote) so the chain, deltas and images are all real --
// no hand-invented delta bytes, no hand-invented AdfEntry trees.

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ADF_BYTES } from '@/lib/adfmfm';
import { addFile } from '@/lib/adffs';
import { formatVolume } from '@/lib/adffs/format';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { diskVersions } from '@/db/schema/disk-history';

const sha256Of = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---- fake diskStore: an in-memory content-addressed map, same shape as the
// real one, just backed by a Map instead of Vercel Blob. ----
const blobBytes = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({
  diskStore: {
    put: (sha256: string, bytes: Uint8Array) => {
      blobBytes.set(sha256, bytes);
      return Promise.resolve({ key: `adf/${sha256}` });
    },
    read: (sha256: string) => {
      const b = blobBytes.get(sha256);
      if (!b) throw new Error(`fake diskStore: no blob ${sha256}`);
      return Promise.resolve(b);
    },
    storageKey: (sha256: string) => `adf/${sha256}`,
  },
}));

// ---- fake @/db: a diskVersions table that actually persists, everything
// else a no-op. store.ts's recordVersion is the only writer; loadEntries and
// this file's own metadata query are the only readers exercised here. ----
let diskVersionRows: Record<string, unknown>[] = [];

function project(row: Record<string, unknown>, cols: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) out[key] = row[key];
  return out;
}

function fakeDb() {
  const applyInsert = (table: unknown, row: Record<string, unknown>) => {
    if (table === diskVersions) {
      diskVersionRows.push({
        // Nullable columns store.ts sometimes omits (e.g. version 0's row):
        // a real insert leaves them NULL, which drizzle reads back as null,
        // never undefined.
        deviceId: null, userId: null, rewindOf: null,
        createdAt: new Date(Date.UTC(2026, 0, 1) + (row.seq as number) * 86_400_000),
        ...row,
      });
    }
  };
  return {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(
            diskVersionRows
              .slice()
              .sort((a, b) => (a.seq as number) - (b.seq as number))
              .map((r) => project(r, cols)),
          ),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const stmt = { __apply: () => applyInsert(table, row) };
        return { ...stmt, onConflictDoNothing: () => stmt };
      },
    }),
    update: () => ({ set: () => ({ where: () => ({ __apply: () => {} }) }) }),
    batch: (stmts: Array<{ __apply: () => void }>) => {
      for (const s of stmts) s.__apply();
      return Promise.resolve([]);
    },
  };
}
vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

beforeEach(() => {
  vi.clearAllMocks();
  blobBytes.clear();
  diskVersionRows = [];
});

const ORG = 'org-1';
const DISK = 'disk-1';

describe('loadHistory', () => {
  it('builds newest-first history with real images, labels and file changes', async () => {
    const { recordVersion } = await import('./store');
    const { loadHistory } = await import('./history');

    // Version 0: as uploaded -- a blank formatted disk. Its bytes are already
    // in the store before any write, same as a real upload.
    const original = formatVolume({ filesystem: 'FFS', volumeName: 'TestDisk' });
    blobBytes.set(sha256Of(original), original);

    // Version 1: a browser edit, adding HELLO.
    const helloResult = addFile(original, ROOT_BLOCK, 'HELLO', new TextEncoder().encode('hi'));
    expect(helloResult.ok).toBe(true);
    if (!helloResult.ok) return;
    const afterHello = helloResult.adf;

    await recordVersion({
      orgId: ORG, diskId: DISK,
      headSha: sha256Of(original), head: original, next: afterHello,
      source: 'browser', userId: 'user-1', sourceFilename: 'TestDisk.adf',
    });

    // Version 2: an amiga write, adding SECOND.
    const secondResult = addFile(afterHello, ROOT_BLOCK, 'SECOND', new TextEncoder().encode('two'));
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    const afterSecond = secondResult.adf;

    await recordVersion({
      orgId: ORG, diskId: DISK,
      headSha: sha256Of(afterHello), head: afterHello, next: afterSecond,
      source: 'amiga', deviceId: 'dev-1', sourceFilename: 'TestDisk.adf',
    });

    // Version 3: overwritten with something that has no filesystem at all
    // (a game disk, or a wipe) -- the sector-note fallback.
    const noFilesystem = new Uint8Array(ADF_BYTES).fill(0xaa);

    await recordVersion({
      orgId: ORG, diskId: DISK,
      headSha: sha256Of(afterSecond), head: afterSecond, next: noFilesystem,
      source: 'browser', userId: 'user-1', sourceFilename: 'TestDisk.adf',
    });

    const deviceNames = new Map([['dev-1', 'Bench board']]);
    const history = await loadHistory(DISK, deviceNames);

    expect(history.map((v) => v.seq)).toEqual([3, 2, 1, 0]);

    // isHead is true only for the newest.
    expect(history.map((v) => v.isHead)).toEqual([true, false, false, false]);

    const [v3, v2, v1, v0] = history;

    // Version 0: as uploaded, no predecessor, no changes.
    expect(v0.label).toBe('As uploaded');
    expect(v0.source).toBe('original');
    expect(v0.changes).toEqual([]);
    expect(v0.sectorNote).toBeNull();

    // Version 1: browser edit, HELLO added.
    expect(v1.label).toBe('Edited in browser');
    expect(v1.source).toBe('browser');
    expect(v1.changes).toEqual([{ path: 'HELLO', kind: 'added', isDir: false }]);
    expect(v1.sectorNote).toBeNull();

    // Version 2: amiga write from a named device, SECOND added.
    expect(v2.label).toBe('Amiga: Bench board');
    expect(v2.source).toBe('amiga');
    expect(v2.changes).toEqual([{ path: 'SECOND', kind: 'added', isDir: false }]);
    expect(v2.sectorNote).toBeNull();

    // Version 3: no readable filesystem -- sector note, not file changes.
    expect(v3.changes).toEqual([]);
    expect(v3.sectorNote).toMatch(/sectors? changed$/);
    expect(v3.sectorCount).toBeGreaterThan(0);

    // Every version carries its stored identity through.
    for (const v of history) {
      expect(v.imageSha256).toHaveLength(64);
      expect(v.createdAt).toBeInstanceOf(Date);
      expect(v.rewindOf).toBeNull();
    }
  });
});
