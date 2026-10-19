// Disk at startup (2026-10-19): the pure half -- what a poll or tap says about the boot, and the stored setting.
import { describe, expect, it } from 'vitest';
import { asBootDisk, parseBoot, bootDiskNote, BOOT_DISK_FW } from './boot-disk';

const q = (s: string) => new URL(`http://x/api/device/poll?${s}`).searchParams;

describe('parseBoot', () => {
  it('reads the boot id, and an update boot only from ota=1', () => {
    expect(parseBoot(q('since=0&boot=1a2b3c4d'))).toEqual({ id: '1a2b3c4d', ota: false });
    expect(parseBoot(q('since=0&boot=deadbeef&ota=1'))).toEqual({ id: 'deadbeef', ota: true });
    expect(parseBoot(q('boot=deadbeef&ota=0'))).toEqual({ id: 'deadbeef', ota: false });
  });
  it('is null for a board that sends none (older firmware), or a malformed one', () => {
    expect(parseBoot(q('since=0'))).toBeNull();
    for (const bad of ['', 'xyz', '1a2b3c4', '1a2b3c4d5', 'DEADBEEF', '00000000', '1a2b3c4d%20'])
      expect(parseBoot(q(`boot=${bad}`))).toBeNull();
  });
});

describe('asBootDisk', () => {
  it('is last for anything but empty', () => {
    expect(asBootDisk('empty')).toBe('empty');
    expect(asBootDisk('last')).toBe('last');
    expect(asBootDisk(null)).toBe('last');
    expect(asBootDisk('nope')).toBe('last');
  });
});

describe('bootDiskNote', () => {
  it('names the firmware a board needs, and nothing once it has it', () => {
    expect(BOOT_DISK_FW).toBe('1.18.1');
    expect(bootDiskNote(false)).toBe('Needs firmware 1.18.1 or newer');
    expect(bootDiskNote(true)).toBeNull();
  });
});
