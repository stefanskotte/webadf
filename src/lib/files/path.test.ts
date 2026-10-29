import { describe, it, expect } from 'vitest';
import { parsePath, formatPath, parentOf, childOf, isWithin, amigaNameProblem, filesHrefForDisk, filesHrefForBoard, PANE_DEVICES, DEFAULT_LEFT, DEFAULT_RIGHT } from './path';

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe('parsePath / formatPath', () => {
  it('parses a device root and nested segments', () => {
    expect(parsePath('LIBRARY:')).toEqual({ device: 'LIBRARY', segments: [] });
    expect(parsePath('LIBRARY:/g1/d1/C/Assign')).toEqual({ device: 'LIBRARY', segments: ['g1', 'd1', 'C', 'Assign'] });
    expect(parsePath('STASH:/Mods/enigma.mod')).toEqual({ device: 'STASH', segments: ['Mods', 'enigma.mod'] });
  });
  it('treats LIBRARY:/ as the device root and refuses a double slash', () => {
    expect(parsePath('LIBRARY:/')).toEqual({ device: 'LIBRARY', segments: [] });
    expect(parsePath('LIBRARY://')).toBeNull();
  });
  it('accepts a trailing slash and round-trips without it', () => {
    expect(formatPath(parsePath('LIBRARY:/g1/')!)).toBe('LIBRARY:/g1');
    expect(formatPath({ device: 'NET', segments: [] })).toBe('NET:');
  });
  it('refuses what is not a path', () => {
    for (const bad of ['', 'library:', 'DH0:/x', 'LIBRARY:x', 'LIBRARY://g1', 'LIBRARY:/g1//d1', 'LIBRARY:/./x',
      'LIBRARY:/../x', 'LIBRARY:/a\u0001b', `LIBRARY:/${'x'.repeat(256)}`, `LIBRARY:${'/x'.repeat(41)}`]) {
      expect(parsePath(bad), bad).toBeNull();
    }
  });
});

describe('navigation', () => {
  it('parentOf walks up and stops at the device', () => {
    expect(formatPath(parentOf(parsePath('LIBRARY:/g1/d1/C')!)!)).toBe('LIBRARY:/g1/d1');
    expect(formatPath(parentOf(parsePath('LIBRARY:/g1')!)!)).toBe('LIBRARY:');
    expect(parentOf(parsePath('LIBRARY:')!)).toBeNull();
  });
  it('childOf appends one segment', () => {
    expect(formatPath(childOf(parsePath('LIBRARY:/g1/d1')!, 'S'))).toBe('LIBRARY:/g1/d1/S');
  });
  it('isWithin is true for the path itself and below, case-insensitively by the given rule', () => {
    const outer = parsePath('LIBRARY:/g1/d1/C')!;
    expect(isWithin(parsePath('LIBRARY:/g1/d1/C')!, outer, ci)).toBe(true);
    expect(isWithin(parsePath('LIBRARY:/g1/d1/c/Tools')!, outer, ci)).toBe(true);
    expect(isWithin(parsePath('LIBRARY:/g1/d1/Libs')!, outer, ci)).toBe(false);
    expect(isWithin(parsePath('LIBRARY:/g1/d2/C')!, outer, ci)).toBe(false);
  });
});

describe('amigaNameProblem', () => {
  it('allows ordinary and international names up to 30 characters', () => {
    expect(amigaNameProblem('ReadMe')).toBeNull();
    expect(amigaNameProblem('Grüße.txt')).toBeNull();
    expect(amigaNameProblem('x'.repeat(30))).toBeNull();
  });
  it('names the problem', () => {
    expect(amigaNameProblem('')).toBe('empty');
    expect(amigaNameProblem('   ')).toBe('empty');
    expect(amigaNameProblem('x'.repeat(31))).toBe('too-long');
    expect(amigaNameProblem('a:b')).toBe('bad-char');
    expect(amigaNameProblem('a/b')).toBe('bad-char');
    expect(amigaNameProblem('a\u0007')).toBe('bad-char');
  });
  it('refuses "." and ".." (unreachable as path segments) but allows names that merely contain dots', () => {
    expect(amigaNameProblem('.')).toBe('bad-char');
    expect(amigaNameProblem('..')).toBe('bad-char');
    expect(amigaNameProblem('...')).toBeNull();
    expect(amigaNameProblem('.hidden')).toBeNull();
  });
  it('refuses characters outside Latin-1, which AmigaDOS would mangle on disk', () => {
    expect(amigaNameProblem('\u{1F600}.txt')).toBe('bad-char'); // emoji
    expect(amigaNameProblem('日本.txt')).toBe('bad-char'); // CJK
    expect(amigaNameProblem('Smile\u{1F600}')).toBe('bad-char');
    expect(amigaNameProblem('Grüße.txt')).toBeNull();
    expect(amigaNameProblem('ÿ')).toBeNull(); // ÿ, last Latin-1 code point
    expect(amigaNameProblem('Ā')).toBe('bad-char'); // Ā, first code point above Latin-1
  });
  it('refuses the C1 control range U+0080-U+009F', () => {
    expect(amigaNameProblem('a\u0085b')).toBe('bad-char'); // NEL
    expect(amigaNameProblem('a\u0080b')).toBe('bad-char');
    expect(amigaNameProblem('a\u009fb')).toBe('bad-char');
    expect(amigaNameProblem('a b')).toBeNull(); // NBSP is printable Latin-1
  });
});

describe('filesHrefForDisk (Task 9; increment 2 R1)', () => {
  it('opens STASH: on the left and the disk on the right, active; with history, its #disk-history', () => {
    const href = filesHrefForDisk('g1', 'd1');
    expect(href).toBe('/files?left=STASH:&right=LIBRARY%3A%2Fg1%2Fd1&active=right');
    const q = new URL(href, 'http://x').searchParams;
    expect([q.get('left'), q.get('right'), q.get('active')]).toEqual(['STASH:', 'LIBRARY:/g1/d1', 'right']);
    expect(filesHrefForDisk('g1', 'd1', true)).toBe(`${href}#disk-history`);
  });
  it('opens a filed title\'s disk inside its collection (Files 2 §3.1)', () => {
    expect(filesHrefForDisk('g', 'd', false, 'c')).toBe(`/files?left=STASH:&right=${encodeURIComponent('LIBRARY:/c/g/d')}&active=right`);
    expect(filesHrefForDisk('g', 'd', true, null)).toBe(`/files?left=STASH:&right=${encodeURIComponent('LIBRARY:/g/d')}&active=right#disk-history`);
  });
});

describe('the panes\' devices (increment 2 R1, increment 3)', () => {
  it('STASH:, NET: and LIBRARY:, STASH: on the left and LIBRARY: on the right by default', () => {
    expect(PANE_DEVICES).toEqual(['STASH', 'NET', 'LIBRARY']);
    expect([DEFAULT_LEFT, DEFAULT_RIGHT]).toEqual(['STASH:', 'LIBRARY:']);
  });
});

describe('filesHrefForBoard (increment 3, R10/R11)', () => {
  it('opens STASH: on the left and the board under NET: on the right, with the pane asked for active', () => {
    const href = filesHrefForBoard('dev 1', 'right');
    expect(href).toBe('/files?left=STASH:&right=NET%3A%2Fdev%201&active=right');
    const q = new URL(href, 'http://x').searchParams;
    expect([q.get('left'), q.get('right'), q.get('active')]).toEqual(['STASH:', 'NET:/dev 1', 'right']);
    expect(filesHrefForBoard('b2', 'left')).toBe('/files?left=STASH:&right=NET%3A%2Fb2&active=left');
  });
});
