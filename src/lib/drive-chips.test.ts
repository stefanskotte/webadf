import { describe, it, expect } from 'vitest';
import { MAX_CHIPS, chipSlots, diskLine, diskText, driveChips, nextLabel, preloadText, protectTag, splitChips, toDriveChip } from './drive-chips';
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
  mountedDiskCount: 2, mountedImageFormat: 'adf', mountedSizeBytes: 901_120,
  desiredGameTitle: 'Turrican',
  macAddress: 'AA:BB:CC:DD:EE:FF',
  trackMaxBytes: null, playsHd: false, preloadSha256: null, preloadState: null, next: null,
  displayVersion: 0, displayAppliedVersion: null, displayError: null, displayLayouts: null, displayPanel: '128x32',
  secondDrive: 'off', secondDriveVersion: 0, secondDriveAppliedVersion: null, secondDriveReported: null,
  df1DiskId: null, df1PickSha256: null, df1PickTitle: null, df1PickDiskNo: null,
  sendVersion: 0, sendRx: null, sendRxAt: null,
  df1Sha256: null, netDriverSeenAt: null, netAmigaIp: null, netFramesIn: null, netFramesOut: null,
  secondDriveCapable: null, sel1Wired: null, df1Seen: null,
  serverCustom: null, serverTls: null,
};

const empty: LiveStateRow = {
  ...loaded,
  desiredDiskId: null, desiredSha256: null,
  mountedDiskId: null, mountedSha256: null, mountedVersion: null,
  diskSha256: null, diskWriteProtected: null, mountedDiskWriteProtected: null,
  mountedGameId: null, mountedGameTitle: null, mountedDiskNo: null,
  mountedDiskCount: null, mountedImageFormat: null, mountedSizeBytes: null,
  desiredGameTitle: null,
};

const chip = (r: LiveStateRow, now = NOW) => toDriveChip(r, now);

const NEXT = { diskNo: 3, diskCount: 4, wraps: false, preload: 'ready' as const };

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

  it('carries the disk number and the title\'s disk count on every title, one-disk ones included (C8 Ruling 4)', () => {
    expect(chip(loaded).disk).toMatchObject({ diskNo: 1, diskCount: 2 });
    expect(chip({ ...loaded, mountedDiskCount: 1 }).disk).toMatchObject({ diskNo: 1, diskCount: 1 });
  });

  it('says how long ago an offline board was seen, and nothing while it is online', () => {
    expect(chip(loaded).seen).toBeNull();
    expect(chip({ ...loaded, lastSeenAt: new Date(NOW - 5 * 60_000) }).seen).toBe('5m ago');
    expect(chip({ ...loaded, lastSeenAt: null }).seen).toBe('never');
  });

  it('an HFE reads WP and cannot be toggled (the PATCH refuses to unprotect one)', () => {
    const c = chip({ ...loaded, mountedImageFormat: 'hfe', mountedDiskWriteProtected: true });
    expect(protectTag(c)).toBe('WP');
    expect(c.canToggleProtect).toBe(false);
    expect(c.canGoTo).toBe(true);
  });

  it("an HD disk follows its library flag like a DD disk (HD writes spec §5.3)", () => {
    const c = chip({ ...loaded, mountedSizeBytes: 1_802_240, mountedDiskWriteProtected: false });
    expect(c.disk?.readOnly).toBeNull();
    expect(protectTag(c)).toBe('RW');
    expect(c.canToggleProtect).toBe(true);
  });

  it('an HFE says HFE', () => {
    expect(chip({ ...loaded, mountedImageFormat: 'hfe' }).disk?.readOnly).toBe('HFE');
    expect(chip(loaded).disk?.readOnly).toBeNull();
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

  it('carries next disk info through only when loaded', () => {
    expect(chip({ ...loaded, next: NEXT }).next).toEqual(NEXT);
    const loading = chip({ ...loaded, next: NEXT, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: 'Lotus' });
    expect(loading.phase).toBe('loading');
    expect(loading.next).toBeNull();
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

describe('chipSlots (C8 spec §2.1: the 240 px chip)', () => {
  it.each([
    [390, 0], [1279, 0], [1280, 1], [1535, 1], [1536, 1], [1919, 1], [1920, 2], [2560, 2],
  ])('a member at %ipx has room for %i chip(s), whatever the board count', (w, n) => {
    for (const boards of [1, 2, 5]) expect(chipSlots(w, false, boards), `${boards} boards`).toBe(n);
  });

  it.each([
    [1280, 1, 1], [1280, 2, 0], [1280, 4, 0], [1535, 2, 0], [1536, 2, 1], [1919, 3, 1], [1920, 2, 2], [2560, 4, 2],
  ])('with the Admin item, at %ipx with %i board(s): %i chip(s) -- none at 1280-1535 once "+k" is needed', (w, boards, n) => {
    expect(chipSlots(w, true, boards)).toBe(n);
  });

  it('below xl there is never a chip, and never more than MAX_CHIPS', () => {
    expect(chipSlots(1279, true, 1)).toBe(0);
    expect(MAX_CHIPS).toBe(2);
    expect(chipSlots(10_000)).toBeLessThanOrEqual(MAX_CHIPS);
    expect(chipSlots(10_000, true, 9)).toBeLessThanOrEqual(MAX_CHIPS);
  });
});

describe('splitChips', () => {
  it('shows every chip when there are two or fewer', () => {
    expect(splitChips([1, 2])).toEqual({ shown: [1, 2], rest: [] });
  });

  it('shows two and puts the rest behind "+k"', () => {
    expect(splitChips([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], rest: [3, 4, 5] });
  });
});

describe('preloadText', () => {
  it('words each state of the preload line', () => {
    expect(preloadText(2, 'ready')).toBe('Disk 2 ready (instant swap)');
    expect(preloadText(2, 'loading')).toBe('Disk 2 loading…');
    expect(preloadText(2, 'waiting')).toBe('Disk 2 not preloaded yet');
  });
});

describe('the DF1 line in the drive menu (spec 2026-10-14 §3.3, plan ruling 7)', () => {
  it('none unless the board runs On', () => {
    expect(toDriveChip(loaded, NOW).df1).toBeNull();
    expect(toDriveChip({ ...loaded, secondDriveReported: 'net' }, NOW).df1).toBeNull();
  });
  it('both states in words while On: the set, or the disk mounted into DF1', () => {
    expect(toDriveChip({ ...loaded, secondDriveReported: 'df1' }, NOW).df1).toBe('DF1: next disk of the set — empty');
    const P = 'e'.repeat(64);
    expect(toDriveChip({
      ...loaded, secondDriveReported: 'df1', df1DiskId: 'disk-x', df1PickTitle: 'Lotus', df1PickDiskNo: 2,
      df1PickSha256: P, df1Sha256: P,
    }, NOW).df1).toBe('DF1: Lotus disk 2 — read-only');
  });
});

describe('diskLine: the card\'s second line, in words for every phase (C8 spec §3.3)', () => {
  it('a loaded disk is its title and "disk n of N", "disk 1 of 1" included', () => {
    expect(diskLine(chip(loaded))).toEqual({ kind: 'title', title: 'Turrican', count: 'disk 1 of 2' });
    expect(diskLine(chip({ ...loaded, mountedDiskCount: 1 }))).toEqual({ kind: 'title', title: 'Turrican', count: 'disk 1 of 1' });
  });
  it('an unknown count leaves the count off rather than guessing', () => {
    expect(diskLine(chip({ ...loaded, mountedDiskCount: null }))).toEqual({ kind: 'title', title: 'Turrican', count: null });
  });
  it('stale numbers ("disk 3 of 2", "disk 1 of 0", "disk 0 of 2") leave the count off', () => {
    for (const [no, count] of [[3, 2], [1, 0], [0, 2], [-1, 2]] as const) {
      expect(diskLine(chip({ ...loaded, mountedDiskNo: no, mountedDiskCount: count })), `${no} of ${count}`)
        .toEqual({ kind: 'title', title: 'Turrican', count: null });
    }
    expect(diskLine(chip({ ...loaded, mountedDiskNo: 2, mountedDiskCount: 2 })))
      .toEqual({ kind: 'title', title: 'Turrican', count: 'disk 2 of 2' });
  });
  it('an empty drive, a load and an eject are words', () => {
    expect(diskLine(chip(empty))).toEqual({ kind: 'text', text: 'Drive empty' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: 'Lotus' })))
      .toEqual({ kind: 'text', text: 'Loading Lotus…' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: 'disk-2', desiredSha256: B, desiredGameTitle: null })))
      .toEqual({ kind: 'text', text: 'Loading a disk…' });
    expect(diskLine(chip({ ...loaded, desiredDiskId: null, desiredSha256: null })))
      .toEqual({ kind: 'text', text: 'Ejecting Turrican…' });
  });
  it('a digest without a disk row (older firmware) is "A disk", with no count and nothing to link', () => {
    expect(diskLine(chip({ ...loaded, mountedDiskId: null, mountedGameId: null, mountedGameTitle: null })))
      .toEqual({ kind: 'text', text: 'A disk' });
  });
});

describe('nextLabel: the Next button\'s words and its accessible name (Plan ruling, WCAG 2.5.3)', () => {
  it('the name starts with the visible words, then the count, then the wrap', () => {
    expect(nextLabel({ diskNo: 2, diskCount: 3, wraps: false, preload: null }))
      .toEqual({ text: 'Next: disk 2', name: 'Next: disk 2 of 3' });
    expect(nextLabel({ diskNo: 1, diskCount: 2, wraps: true, preload: 'ready' }))
      .toEqual({ text: 'Next: disk 1', name: 'Next: disk 1 of 2 (wraps)' });
  });
});
