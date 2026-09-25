import { describe, it, expect } from 'vitest';
import { MAX_CHIPS, chipSlots, diskText, driveChips, protectTag, splitChips, toDriveChip } from './drive-chips';
import { STALE_AFTER_MS } from './device-state';
import type { LiveStateRow } from './live-state';

const NOW = 1_800_000_000_000;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** A converged, online board holding disk 1 of a two-disk game, protected. */
const loaded: LiveStateRow = {
  id: 'dev-a', name: 'Bench',
  desiredDiskId: 'disk-1', desiredSha256: A, desiredVersion: 4,
  mountedDiskId: 'disk-1', mountedSha256: A, mountedVersion: 4,
  lastSeenAt: new Date(NOW - 5_000),
  diskSha256: A, diskWriteProtected: true,
  mountedDiskWriteProtected: true,
  firmwareVersion: '1.0.0',
  desiredFirmwareVersion: null, firmwareUpdateState: null,
  updateProtocol: null, firmwareUpdateError: null,
  lastError: null, lastErrorAt: null,
  mountedGameId: 'gam-1', mountedGameTitle: 'Turrican', mountedDiskNo: 1,
  mountedDiskCount: 2, mountedImageFormat: 'adf', desiredGameTitle: 'Turrican',
  macAddress: 'AA:BB:CC:DD:EE:FF',
};

const empty: LiveStateRow = {
  ...loaded,
  desiredDiskId: null, desiredSha256: null,
  mountedDiskId: null, mountedSha256: null, mountedVersion: null,
  diskSha256: null, diskWriteProtected: null, mountedDiskWriteProtected: null,
  mountedGameId: null, mountedGameTitle: null, mountedDiskNo: null,
  mountedDiskCount: null, mountedImageFormat: null, desiredGameTitle: null,
};

const chip = (r: LiveStateRow, now = NOW) => toDriveChip(r, now);

describe('toDriveChip', () => {
  it('an empty drive says "empty" and offers nothing but a disabled menu', () => {
    const c = chip(empty);
    expect(c.phase).toBe('empty');
    expect(diskText(c)).toBe('empty');
    expect(protectTag(c)).toBeNull();
    expect([c.canGoTo, c.canToggleProtect, c.canEject]).toEqual([false, false, false]);
  });

  it('a converged board shows the disk it REPORTED, with its write-protect as WP', () => {
    const c = chip(loaded);
    expect(c.phase).toBe('loaded');
    expect(diskText(c)).toBe('Turrican');
    expect(c.disk).toMatchObject({ id: 'disk-1', gameId: 'gam-1', diskNo: 1, writeProtected: true });
    expect(protectTag(c)).toBe('WP');
    expect([c.canGoTo, c.canToggleProtect, c.canEject]).toEqual([true, true, true]);
  });

  it('shows RW for a writable disk -- both values of the state, never an absent tag', () => {
    expect(protectTag(chip({ ...loaded, mountedDiskWriteProtected: false }))).toBe('RW');
  });

  it('leaves the disk number off a one-disk game', () => {
    expect(chip({ ...loaded, mountedDiskCount: 1 }).disk?.diskNo).toBeNull();
  });

  it('an HFE reads WP and cannot be toggled (the PATCH refuses to unprotect one)', () => {
    const c = chip({ ...loaded, mountedImageFormat: 'hfe', mountedDiskWriteProtected: true });
    expect(protectTag(c)).toBe('WP');
    expect(c.canToggleProtect).toBe(false);
    expect(c.canGoTo).toBe(true);
  });

  it('a mount in flight reads "loading…", names what was asked for, and never the OLD disk', () => {
    // Board still holds disk 1 (A); disk 2 (B) was asked for.
    const c = chip({ ...loaded, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: 'Lotus' });
    expect(c.state).toBe('pending');
    expect(c.phase).toBe('loading');
    expect(diskText(c)).toBe('loading…');
    expect(c.loadingTitle).toBe('Lotus');
    expect(c.disk).toBeNull();
    expect(protectTag(c)).toBeNull();
    expect([c.canGoTo, c.canToggleProtect, c.canEject]).toEqual([false, false, true]);
  });

  it('an eject in flight reads "ejecting…" until the board reports empty', () => {
    const c = chip({ ...loaded, desiredDiskId: null, desiredSha256: null });
    expect(c.phase).toBe('ejecting');
    expect(diskText(c)).toBe('ejecting…');
    // The disk is still physically in the drive, so "go to" still has a target;
    // the toggle does not -- the board no longer desires it, so a flip would
    // not reach it (the PATCH bumps only devices that DESIRE the disk).
    expect([c.canGoTo, c.canToggleProtect, c.canEject]).toEqual([true, false, true]);
  });

  it('an offline board is offline on the chip, and can still be asked to eject', () => {
    const c = chip({ ...loaded, lastSeenAt: new Date(NOW - STALE_AFTER_MS - 1_000) });
    expect(c.online).toBe(false);
    expect(c.phase).toBe('loaded');
    expect(c.canEject).toBe(true);
  });

  it('a stale eject (offline, outstanding) is still "ejecting…", with the board shown offline', () => {
    const c = chip({ ...loaded, desiredSha256: null, desiredDiskId: null, lastSeenAt: new Date(NOW - 10 * 60_000) });
    expect(c.state).toBe('stale');
    expect(c.phase).toBe('ejecting');
    expect(c.online).toBe(false);
  });

  it('a digest without a disk id (older firmware) is "a disk" with no row to act on', () => {
    const c = chip({ ...loaded, mountedDiskId: null, mountedGameId: null, mountedGameTitle: null });
    expect(diskText(c)).toBe('a disk');
    expect([c.canGoTo, c.canToggleProtect, c.canEject]).toEqual([false, false, true]);
  });
});

describe('shortName', () => {
  it('keeps a real alias as it is', () => {
    expect(chip(loaded).shortName).toBe('Bench');
  });

  it('shortens the default "Device <MAC>" to the MAC tail, which is what tells two boards apart', () => {
    const c = chip({ ...loaded, name: 'Device AA:BB:CC:DD:EE:FF' });
    expect(c.shortName).toBe('…EE:FF');
    expect(c.name).toBe('Device AA:BB:CC:DD:EE:FF');
  });
});

describe('driveChips', () => {
  it('orders by name, like /devices, with the id as the tiebreak', () => {
    const rows = [
      { ...loaded, id: 'z', name: 'Bench' },
      { ...loaded, id: 'b', name: 'Attic' },
      { ...loaded, id: 'a', name: 'Bench' },
    ];
    expect(driveChips(rows, NOW).map((c) => c.id)).toEqual(['b', 'a', 'z']);
  });

  it('is empty for an org with no devices -- the layout then renders nothing', () => {
    expect(driveChips([], NOW)).toEqual([]);
  });
});

describe('chipSlots', () => {
  it.each([
    [390, 0], [1279, 0], [1280, 1], [1535, 1], [1536, 2], [1919, 2], [1920, 3], [2560, 3],
  ])('at %ipx there is room for %i chip(s)', (w, n) => {
    expect(chipSlots(w)).toBe(n);
  });

  it('never exceeds MAX_CHIPS', () => {
    expect(chipSlots(10_000)).toBeLessThanOrEqual(MAX_CHIPS);
  });
});

describe('splitChips', () => {
  it('shows every chip when there are three or fewer', () => {
    expect(splitChips([1, 2, 3])).toEqual({ shown: [1, 2, 3], rest: [] });
  });

  it('shows three and puts the rest behind "+k"', () => {
    expect(splitChips([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], rest: [4, 5] });
  });
});
