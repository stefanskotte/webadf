import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PAULANET_DISK_SHA256, PAULANET_NEXT, ALWAYS_REFERENCED_BLOBS, servedWithoutEntitlement, netApplied, netNextRearm,
  netKeepsDriverDisk, PAULANET_DISK_PREVIOUS, driverDiskFor, isDriverDisk, netNextRearmCandidate,
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

describe('netKeepsDriverDisk (final review m1): the board runs Network, whatever version it reported', () => {
  const t = { secondDrive: 'net', secondDriveReported: 'net' };
  it('holds when Network is chosen and the board reports Network, at any version', () => {
    expect(netKeepsDriverDisk(t)).toBe(true);
  });
  it('does not hold when the board reports another mode or nothing, or the user left Network', () => {
    expect(netKeepsDriverDisk({ ...t, secondDriveReported: 'df1' })).toBe(false);
    expect(netKeepsDriverDisk({ ...t, secondDriveReported: null })).toBe(false);
    expect(netKeepsDriverDisk({ ...t, secondDrive: 'off' })).toBe(false);
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

describe('the driver disk rollout (plan 2026-10-17 R16)', () => {
  const NOW = 1_800_000_000_000;
  it('keeps the older disk while the Amiga\'s driver talks, never swapping DF1 under it', () => {
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - 10_000) }, NOW)).toBe(PAULANET_DISK_PREVIOUS);
  });
  it('names the new disk once the driver is quiet, or to a board that holds neither', () => {
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - 200_000) }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: null }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: null, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_SHA256, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
  });
  it('serves and keeps both digests, and nothing else', () => {
    expect(isDriverDisk(PAULANET_DISK_PREVIOUS) && isDriverDisk(PAULANET_DISK_SHA256)).toBe(true);
    expect(isDriverDisk('a'.repeat(64)) || isDriverDisk(null)).toBe(false);
    expect(servedWithoutEntitlement(PAULANET_DISK_PREVIOUS)).toBe(true);
    expect([...ALWAYS_REFERENCED_BLOBS].sort()).toEqual([PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256].sort());
  });
  it('a board holding the older disk stays a re-arm candidate, so the new one goes in once the Amiga is off', () => {
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_PREVIOUS })).toBe(true);
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_SHA256 })).toBe(false);
  });
});
