import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PAULANET_DISK_SHA256, PAULANET_NEXT, ALWAYS_REFERENCED_BLOBS, servedWithoutEntitlement, netApplied, netNextRearm,
} from './paulanet-disk';

describe('the PaulaNET driver disk', () => {
  it('is the disk tools/paulanet-disk builds (one pinned digest, two places)', () => {
    expect(PAULANET_DISK_SHA256).toBe(readFileSync('tools/paulanet-disk/paulanet-disk.sha256', 'utf8').trim());
    expect(PAULANET_DISK_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rides the poll as next, with a fixed id and disk number', () => {
    expect(PAULANET_NEXT).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
  });
  it('is the only digest a board may fetch without owning it', () => {
    expect(servedWithoutEntitlement(PAULANET_DISK_SHA256)).toBe(true);
    expect(servedWithoutEntitlement('0'.repeat(64))).toBe(false);
  });
  it('is kept by the blob GC', () => expect(ALWAYS_REFERENCED_BLOBS).toContain(PAULANET_DISK_SHA256));
});

describe('netApplied (pre-flight I2): the board reports Network for the current setting', () => {
  const t = { secondDrive: 'net', secondDriveVersion: 4, secondDriveReported: 'net', secondDriveAppliedVersion: 4 };
  it('holds only when chosen, reported and acknowledged at the current version', () => {
    expect(netApplied(t)).toBe(true);
  });
  it('does not hold on the choice alone, an older ack, another reported mode, or a board that never said', () => {
    expect(netApplied({ ...t, secondDriveReported: 'df1' })).toBe(false);
    expect(netApplied({ ...t, secondDriveReported: null })).toBe(false);
    expect(netApplied({ ...t, secondDriveAppliedVersion: 3 })).toBe(false);
    expect(netApplied({ ...t, secondDriveAppliedVersion: null })).toBe(false);
    expect(netApplied({ ...t, secondDrive: 'df1' })).toBe(false);   // the user has since left Network
  });
});

describe('netNextRearm (Task 8 review I1): a lost wake response is retried, at most once per 5 minutes', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const row = { secondDrive: 'net', secondDriveVersion: 3, netNextSentVersion: 3, netNextRearmedAt: null as Date | null };
  const report = { secondDrive: 'net', driveVersion: 3, df1Sha256: null as string | null };
  it('re-arms when Network is applied at the current version, the cursor is set, and DF1 lacks the disk', () => {
    expect(netNextRearm(row, report, now)).toBe(true);
    expect(netNextRearm(row, { ...report, df1Sha256: 'b'.repeat(64) }, now)).toBe(true);
  });
  it('never while DF1 holds the driver disk', () => {
    expect(netNextRearm(row, { ...report, df1Sha256: PAULANET_DISK_SHA256 }, now)).toBe(false);
  });
  it('not twice within 5 minutes; again after', () => {
    expect(netNextRearm({ ...row, netNextRearmedAt: new Date(now.getTime() - 299_000) }, report, now)).toBe(false);
    expect(netNextRearm({ ...row, netNextRearmedAt: new Date(now.getTime() - 300_000) }, report, now)).toBe(true);
  });
  it('not when the cursor is already clear, or Network is not applied for the current setting', () => {
    expect(netNextRearm({ ...row, netNextSentVersion: null }, report, now)).toBe(false);
    expect(netNextRearm(row, { ...report, driveVersion: 2 }, now)).toBe(false);
    expect(netNextRearm(row, { ...report, secondDrive: 'df1' }, now)).toBe(false);
    expect(netNextRearm({ ...row, secondDrive: 'df1' }, report, now)).toBe(false);
    expect(netNextRearm(row, { ...report, df1Sha256: undefined }, now)).toBe(false);   // a report silent on DF1
  });
  it('Next disk and Off modes are untouched', () => {
    for (const m of ['df1', 'off']) {
      expect(netNextRearm({ ...row, secondDrive: m }, { ...report, secondDrive: m }, now)).toBe(false);
    }
  });
});
