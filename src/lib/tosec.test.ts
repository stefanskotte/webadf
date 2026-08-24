import { describe, it, expect } from 'vitest';
import { parseTosecName } from './tosec';

describe('parseTosecName', () => {
  it('parses a full TOSEC name', () => {
    const r = parseTosecName('Project-X (1992)(Team 17)(Disk 1 of 4)[cr NMS].adf');
    expect(r.title).toBe('Project-X');
    expect(r.year).toBe(1992);
    expect(r.publisher).toBe('Team 17');
    expect(r.diskNo).toBe(1);
    expect(r.diskCount).toBe(4);
    expect(r.flags).toContain('cr NMS');
  });

  it('handles a single-disk release with no disk clause', () => {
    const r = parseTosecName('Marble Slide (1990)(Handel, Peter)(PD).adf');
    expect(r.title).toBe('Marble Slide');
    expect(r.year).toBe(1990);
    expect(r.publisher).toBe('Handel, Peter');
    expect(r.diskNo).toBeNull();
  });

  it('falls back to the bare stem for a non-TOSEC filename', () => {
    const r = parseTosecName('9Fingers_D1.adf');
    expect(r.title).toBe('9Fingers_D1');
    expect(r.year).toBeNull();
    expect(r.publisher).toBeNull();
  });

  it('splits on the FINAL -N so titles containing dashes survive', () => {
    const r = parseTosecName('Example - Space Unknown-2.adf');
    expect(r.title).toBe('Example - Space Unknown');
    expect(r.diskNo).toBe(2);
  });

  it('does not mistake a hyphenated title for a disk number', () => {
    const r = parseTosecName('Project-X.adf');
    expect(r.title).toBe('Project-X');
    expect(r.diskNo).toBeNull();
  });

  it('parses "Disk N of M" case-insensitively', () => {
    expect(parseTosecName('X (1990)(Y)(disk 3 of 5).adf').diskNo).toBe(3);
  });

  it('strips a leading article for sortTitle', () => {
    expect(parseTosecName('The Settlers (1993)(Blue Byte).adf').sortTitle)
      .toBe('settlers, the');
  });

  it('is case-insensitive about the extension', () => {
    expect(parseTosecName('Real_Amiga_Install.ADF').title).toBe('Real_Amiga_Install');
  });

  it('collects multiple bracket flags', () => {
    const r = parseTosecName('Y (1991)(Z)[cr ABC][t +2 DEF].adf');
    expect(r.flags).toEqual(['cr ABC', 't +2 DEF']);
  });
});
