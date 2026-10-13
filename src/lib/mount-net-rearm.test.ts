// recordStatus re-arms the driver-disk wake after a lost response (Task 8 review I1). A fake row stands in for
// the devices row: the poll's markNetNextSent sets the cursor, recordStatus reads it and clears it with a
// compare-and-set in its one UPDATE (the CAS succeeds here: nothing else writes between).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

type Row = {
  secondDrive: string; secondDriveVersion: number;
  netNextSentVersion: number | null; netNextRearmedAt: Date | null;
};
let row: Row;
let patches: Record<string, unknown>[] = [];
let reads = 0;
const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);
const isSql = (v: unknown) => typeof v === 'object' && v !== null && 'queryChunks' in v;

const fakeDb = {
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      patches.push(patch);
      // Apply the two columns this test is about. A CASE is the CAS; nothing raced, so it takes.
      if ('netNextSentVersion' in patch) {
        row.netNextSentVersion = isSql(patch.netNextSentVersion) ? null : (patch.netNextSentVersion as number);
      }
      if (isSql(patch.netNextRearmedAt)) row.netNextRearmedAt = clock;
      return { where: async () => undefined };
    },
  }),
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => { reads++; return [{ ...row }]; } }) }),
  }),
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

let clock = new Date('2026-10-13T12:00:00Z');
const { recordStatus, markNetNextSent } = await import('./mount');

const report = (over: Record<string, unknown> = {}) => ({
  mountedSha256: null, firmwareVersion: '1.11.0', secondDrive: 'net' as const, driveVersion: 3,
  df1Sha256: null as string | null, ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  clock = new Date('2026-10-13T12:00:00Z');
  vi.setSystemTime(clock);
  row = { secondDrive: 'net', secondDriveVersion: 3, netNextSentVersion: null, netNextRearmedAt: null };
  patches = [];
  reads = 0;
});
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); vi.setSystemTime(clock); };

describe('recordStatus re-arms the driver-disk wake', () => {
  it('lost response -> the next status report re-arms -> the cursor is clear for the next poll to send again', async () => {
    await markNetNextSent('dev-1', 3);                 // the wake body went out (and was lost)
    expect(row.netNextSentVersion).toBe(3);
    await recordStatus('dev-1', report());             // DF1 still empty
    expect(row.netNextSentVersion).toBeNull();         // the poll's cursor test now wakes (poll route.test.ts)
    expect(row.netNextRearmedAt).toEqual(clock);
    // The CAS compares what it read: a cursor the poll moved meanwhile is left alone.
    const q = render(patches.at(-1)!.netNextSentVersion);
    expect(q.sql).toMatch(/^case when "devices"."net_next_sent_version" = \$1 and "devices"."second_drive_version" = \$2 then null else "devices"."net_next_sent_version" end$/);
    expect(q.params).toEqual([3, 3]);
  });

  it('no second re-arm within 5 minutes, one after', async () => {
    await markNetNextSent('dev-1', 3);
    await recordStatus('dev-1', report());
    expect(row.netNextSentVersion).toBeNull();
    advance(60_000);
    await markNetNextSent('dev-1', 3);                 // the re-armed wake went out; lost again
    await recordStatus('dev-1', report());
    expect(row.netNextSentVersion).toBe(3);            // rate-limited
    advance(240_000);                                  // 5 minutes since the re-arm
    await recordStatus('dev-1', report());
    expect(row.netNextSentVersion).toBeNull();
  });

  it('holding the driver disk -> no re-arm, and no extra read', async () => {
    await markNetNextSent('dev-1', 3);
    await recordStatus('dev-1', report({ df1Sha256: PAULANET_DISK_SHA256 }));
    expect(row.netNextSentVersion).toBe(3);
    expect(reads).toBe(0);
  });

  it('Next disk and Off reports are untouched, with no extra read', async () => {
    row.secondDrive = 'df1';
    row.netNextSentVersion = 2;
    await recordStatus('dev-1', report({ secondDrive: 'df1' }));
    await recordStatus('dev-1', report({ secondDrive: 'off' }));
    expect(row.netNextSentVersion).toBe(2);
    expect(reads).toBe(0);
    expect(patches.every((p) => !('netNextSentVersion' in p) && !('netNextRearmedAt' in p))).toBe(true);
  });

  it('a report for an older setting version does not re-arm', async () => {
    await markNetNextSent('dev-1', 3);
    await recordStatus('dev-1', report({ driveVersion: 2 }));
    expect(row.netNextSentVersion).toBe(3);
  });
});
