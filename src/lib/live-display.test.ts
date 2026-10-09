import { describe, expect, it } from 'vitest';
import { liveDisplayState, liveDisplayText, rssiBars, type LiveDisplayFields } from './live-display';

const empty: LiveDisplayFields = {
  rssi: -55, mountedSha256: null, mountedGame: null, mountedDiskNo: null,
  mountedLabel: null, mountedDiskCount: null, mountedWriteProtected: null, nfcReader: null,
};
const mounted: LiveDisplayFields = {
  ...empty, mountedSha256: 'ab', mountedGame: 'Workbench 3.1', mountedDiskNo: 2,
  mountedLabel: 'Extras', mountedDiskCount: 6, mountedWriteProtected: false,
};

describe('liveDisplayState', () => {
  it('an empty drive reads "No disk", as the firmware says after an eject', () => {
    const s = liveDisplayState(empty, true, 0);
    expect(s.status).toBe('ready');
    expect(s.title).toBe('No disk');
    expect(s.detail).toBe('');
  });

  it('a multi-disk title gets "Disk n/c label", like ui_observe', () => {
    const s = liveDisplayState(mounted, true, 0);
    expect(s.status).toBe('loaded');
    expect(s.title).toBe('Workbench 3.1');
    expect(s.detail).toBe('Disk 2/6 Extras');
    expect(s.writable).toBe(true);
  });

  it('a one-disk title shows the label alone, and a missing label is "Disk n"', () => {
    const s = liveDisplayState({ ...mounted, mountedDiskCount: 1, mountedLabel: null }, true, 0);
    expect(s.detail).toBe('Disk 2');
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
    expect(liveDisplayText(liveDisplayState(mounted, true, 0))).toBe('Workbench 3.1 — Disk 2/6 Extras');
    expect(liveDisplayText(liveDisplayState(empty, true, 0))).toBe('No disk');
  });
});

describe('rssiBars', () => {
  it('uses the firmware thresholds', () => {
    expect([null, 0, -50, -60, -65, -75, -85].map(rssiBars)).toEqual([-1, -1, 3, 3, 2, 1, 0]);
  });
});
