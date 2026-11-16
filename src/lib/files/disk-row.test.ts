import { describe, it, expect } from 'vitest';
import { diskImageSize, diskRowWords, paneSize } from './disk-row';

describe('diskRowWords (a disk row reads as a disk image, ruling 2026-11-15)', () => {
  it('a DD ADF: "Disk 1 · ADF, 880 KB", heard as "disk image Disk 1, ADF, 880 KB"', () => {
    const w = diskRowWords({ name: 'Disk 1', imageFormat: 'adf', size: 901_120 });
    expect(w.text).toBe('Disk 1 · ADF, 880 KB');
    expect(w.spoken).toBe('disk image Disk 1, ADF, 880 KB');
    expect(w.detail).toBe('ADF, 880 KB');
    expect(w.format).toBe('ADF');
    expect(w.size).toBe('880 KB');
  });

  it('an HD ADF says 1.76 MB, as Create ADF and the disk page do, not paneSize\'s 1.7 MB', () => {
    expect(diskRowWords({ name: 'Disk 2', imageFormat: 'adf', size: 1_802_240 }).text).toBe('Disk 2 · ADF, 1.76 MB');
    expect(paneSize(1_802_240)).toBe('1.7 MB');
  });

  it('an HFE says HFE and its own size, as the panes count bytes', () => {
    expect(diskRowWords({ name: 'Disk 1', imageFormat: 'hfe', size: 2_097_664 }).text).toBe('Disk 1 · HFE, 2.0 MB');
    expect(diskImageSize('hfe', 600_000)).toBe('586 KB');
    // HD's "1.76 MB" names the ADF geometry: an HFE of that byte count says what paneSize says.
    expect(diskImageSize('hfe', 1_802_240)).toBe('1.7 MB');
  });

  it('an ADF of neither geometry, and a missing format (the schema default is adf)', () => {
    expect(diskRowWords({ name: 'Odd', imageFormat: 'adf', size: 819_200 }).text).toBe('Odd · ADF, 800 KB');
    expect(diskRowWords({ name: 'Disk 1', size: 901_120 }).text).toBe('Disk 1 · ADF, 880 KB');
  });

  it('no size known: the format alone', () => {
    const w = diskRowWords({ name: 'Disk 1', imageFormat: 'adf', size: null });
    expect(w.text).toBe('Disk 1 · ADF');
    expect(w.spoken).toBe('disk image Disk 1, ADF');
    expect(w.size).toBeNull();
  });

  it('keeps the label as it is: a label naming its title is not touched', () => {
    expect(diskRowWords({ name: 'Mouseski (Disk 1)', imageFormat: 'adf', size: 901_120 }).text).toBe('Mouseski (Disk 1) · ADF, 880 KB');
  });
});
