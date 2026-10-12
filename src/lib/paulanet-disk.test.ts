import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PAULANET_DISK_SHA256, PAULANET_NEXT, ALWAYS_REFERENCED_BLOBS, servedWithoutEntitlement, netApplied,
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
