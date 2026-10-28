import { describe, it, expect } from 'vitest';
import { parsePath, formatPath, parentOf, childOf, isWithin, amigaNameProblem } from './path';

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe('parsePath / formatPath', () => {
  it('parses a device root and nested segments', () => {
    expect(parsePath('LIBRARY:')).toEqual({ device: 'LIBRARY', segments: [] });
    expect(parsePath('LIBRARY:/g1/d1/C/Assign')).toEqual({ device: 'LIBRARY', segments: ['g1', 'd1', 'C', 'Assign'] });
    expect(parsePath('STASH:/Mods/enigma.mod')).toEqual({ device: 'STASH', segments: ['Mods', 'enigma.mod'] });
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
});
