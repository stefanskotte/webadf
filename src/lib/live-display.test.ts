import { describe, expect, it } from 'vitest';
import {
  liveDisplayState, liveDisplayText, rssiBars, NO_DISK_WORD_FW, type LiveDisplayFields,
} from './live-display';

const empty: LiveDisplayFields = {
  rssi: -55, mountedSha256: null, mountedGame: null, mountedDiskNo: null,
  mountedLabel: null, mountedSourceFilename: null, mountedDiskCount: null, mountedWriteProtected: null, nfcReader: null,
  firmwareVersion: '1.14.0+g5f5a1b3',
};
const mounted: LiveDisplayFields = {
  ...empty, mountedSha256: 'ab', mountedGame: 'Workbench 3.1', mountedDiskNo: 2,
  mountedLabel: 'Extras', mountedDiskCount: 6, mountedWriteProtected: false,
};
// A board on firmware from before the word "Disk" was dropped.
const old = (d: LiveDisplayFields): LiveDisplayFields => ({ ...d, firmwareVersion: '1.13.0+g290990b' });

describe('liveDisplayState', () => {
  it('an empty drive reads "No disk", as the firmware says after an eject', () => {
    const s = liveDisplayState(empty, true, 0);
    expect(s.status).toBe('ready');
    expect(s.title).toBe('No disk');
    expect(s.detail).toBe('');
  });

  it('a multi-disk title gets "n/c label", like ui_observe (nfc_ui_disk_line) -- no word "Disk"', () => {
    const s = liveDisplayState(mounted, true, 0);
    expect(s.status).toBe('loaded');
    expect(s.title).toBe('Workbench 3.1');
    expect(s.detail).toBe('2/6 Extras');
    expect(s.writable).toBe(true);
  });

  it('a one-disk title shows the label alone, and a missing label with no file name is an empty line', () => {
    expect(liveDisplayState({ ...mounted, mountedDiskCount: 1 }, true, 0).detail).toBe('Extras');
    expect(liveDisplayState({ ...mounted, mountedDiskCount: 1, mountedLabel: null }, true, 0).detail).toBe('');
  });

  it('a disk with no label shows its uploaded file name without the extension, as mount.ts sends', () => {
    const s = liveDisplayState({ ...mounted, mountedLabel: null, mountedSourceFilename: 'Locale.adf' }, true, 0);
    expect(s.detail).toBe('2/6 Locale');
  });

  it('the label (the stored volume name) wins over the file name', () => {
    const s = liveDisplayState({ ...mounted, mountedSourceFilename: 'wb31_extras.adf' }, true, 0);
    expect(s.detail).toBe('2/6 Extras');
  });

  it('a multi-disk title with no name at all is the counter alone, no trailing space', () => {
    const s = liveDisplayState({ ...mounted, mountedLabel: null }, true, 0);
    expect(s.detail).toBe('2/6');
  });

  it('write protection unknown is not shown as writable', () => {
    expect(liveDisplayState({ ...mounted, mountedWriteProtected: null }, true, 0).writable).toBe(false);
  });

  it('the NFC icon follows the reported reader; never-reported reads as absent, never as armed', () => {
    expect(liveDisplayState({ ...mounted, nfcReader: 'present' }, true, 0).nfc).toBe('present');
    expect(liveDisplayState({ ...mounted, nfcReader: 'absent' }, true, 0).nfc).toBe('absent');
    expect(liveDisplayState(empty, true, 0).nfc).toBe('absent');
  });

  it('never invents a track position', () => {
    expect(liveDisplayState(mounted, true, 0).showTrack).toBe(false);
  });

  it('an offline board shows no Wi-Fi arcs and an offline cloud', () => {
    const s = liveDisplayState(mounted, false, 0);
    expect(s.bars).toBe(-1);
    expect(s.sync).toBe('offline');
  });

  it('describes itself in words', () => {
    expect(liveDisplayText(liveDisplayState(mounted, true, 0))).toBe('Workbench 3.1 — 2/6 Extras');
    expect(liveDisplayText(liveDisplayState(empty, true, 0))).toBe('No disk');
  });
});

describe('liveDisplayState on firmware before NO_DISK_WORD_FW: the board still prints "Disk n/c label"', () => {
  it('the boundary is 1.14.0, the version that drops the word', () => {
    expect(NO_DISK_WORD_FW).toBe('1.14.0');
    expect(liveDisplayState({ ...mounted, firmwareVersion: '1.14.0+gabcdef0' }, true, 0).detail).toBe('2/6 Extras');
    expect(liveDisplayState({ ...mounted, firmwareVersion: '1.15.2+gabcdef0' }, true, 0).detail).toBe('2/6 Extras');
  });

  it('a set\'s disk reads "Disk n/c label", as that firmware draws it', () => {
    expect(liveDisplayState(old(mounted), true, 0).detail).toBe('Disk 2/6 Extras');
    expect(liveDisplayText(liveDisplayState(old(mounted), true, 0))).toBe('Workbench 3.1 — Disk 2/6 Extras');
  });

  it('with no name, the old firmware\'s own trailing space is kept: "Disk n/c "', () => {
    expect(liveDisplayState(old({ ...mounted, mountedLabel: null }), true, 0).detail).toBe('Disk 2/6 ');
  });

  it('a one-disk title is the label alone on either firmware', () => {
    expect(liveDisplayState(old({ ...mounted, mountedDiskCount: 1 }), true, 0).detail).toBe('Extras');
    expect(liveDisplayState(old({ ...mounted, mountedDiskCount: 1, mountedLabel: null }), true, 0).detail).toBe('');
  });

  it('an unknown or unreadable version is treated as old firmware (firmwareAtLeast\'s rule)', () => {
    expect(liveDisplayState({ ...mounted, firmwareVersion: null }, true, 0).detail).toBe('Disk 2/6 Extras');
    expect(liveDisplayState({ ...mounted, firmwareVersion: 'garbage' }, true, 0).detail).toBe('Disk 2/6 Extras');
  });
});

describe('rssiBars', () => {
  it('uses the firmware thresholds', () => {
    expect([null, 0, -50, -60, -65, -75, -85].map(rssiBars)).toEqual([-1, -1, 3, 3, 2, 1, 0]);
  });
});
