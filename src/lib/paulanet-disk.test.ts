import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PAULANET_DISK_SHA256, PAULANET_NEXT, ALWAYS_REFERENCED_BLOBS, servedWithoutEntitlement, netApplied, netNextRearm,
  netKeepsDriverDisk, PAULANET_DISK_PREVIOUS, driverDiskFor, isDriverDisk, netNextRearmCandidate, ROLLOUT_QUIET_MS,
  NET_REARM_MIN_MS, PAULANET_DISK_OLDER,
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
  // Fix round 1 ruling: the spec's "DF1 never changes under a running driver" outranks the card's 120 s "talking";
  // the rollout waits for a quiet of its own, two re-arm periods (10 min).
  it('waits two re-arm periods of quiet, wider than the card\'s 120 s "talking"', () => {
    expect(ROLLOUT_QUIET_MS).toBe(2 * NET_REARM_MIN_MS);
    expect(ROLLOUT_QUIET_MS).toBe(600_000);
  });
  it('keeps the older disk while the Amiga\'s driver was heard within 10 min, never swapping DF1 under it', () => {
    for (const ago of [10_000, 200_000, 600_000]) {
      expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - ago) }, NOW)).toBe(PAULANET_DISK_PREVIOUS);
    }
  });
  it('names the new disk once the driver has been quiet 10 min, or was never heard, or to a board that holds neither', () => {
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - 600_001) }, NOW)).toBe(PAULANET_DISK_SHA256);
    // null = never heard while in Network mode (a board restart no longer clears it: recordStatus keeps the last reading).
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: null }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: null, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_SHA256, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
  });
  it('serves and keeps the current disk and every older one, and nothing else (Transfer 2.3, 2026-10-30)', () => {
    expect(PAULANET_DISK_OLDER).toEqual([PAULANET_DISK_PREVIOUS, '36bce70c114ad2eff6cdbb720ffaeabdbf79856592211080b437f7ac3110f796',
      '6e799db55e95a52900bff0ea6e3155b7787a44bcd5c5371510522cff0d5820f9',
      '1ca4f4cb402042e9c842bcf7af91fb86cf5587125ba64134b26f4d25d35a352d',
      'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287', '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e']);
    expect(PAULANET_DISK_PREVIOUS).toBe('9f58337d1a8bde3da2cce4fc26e97eed9ca77f9c16b12c58fea0373e898699fa');
    for (const sha of [PAULANET_DISK_SHA256, ...PAULANET_DISK_OLDER]) {
      expect(isDriverDisk(sha)).toBe(true);
      expect(servedWithoutEntitlement(sha)).toBe(true);
    }
    expect(isDriverDisk('a'.repeat(64)) || isDriverDisk(null)).toBe(false);
    expect([...ALWAYS_REFERENCED_BLOBS].sort()).toEqual([PAULANET_DISK_SHA256, ...PAULANET_DISK_OLDER].sort());
  });
  it('leaves any older disk in DF1 while the Amiga runs, the disk before Receive too', () => {
    for (const before of PAULANET_DISK_OLDER.slice(1)) {
      expect(driverDiskFor({ df1Sha256: before, netDriverSeenAt: new Date(NOW - 10_000) }, NOW)).toBe(before);
      expect(driverDiskFor({ df1Sha256: before, netDriverSeenAt: new Date(NOW - 600_001) }, NOW)).toBe(PAULANET_DISK_SHA256);
    }
  });
  it('a board holding the older disk stays a re-arm candidate, so the new one goes in once the Amiga is off', () => {
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_PREVIOUS })).toBe(true);
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_SHA256 })).toBe(false);
  });
});
