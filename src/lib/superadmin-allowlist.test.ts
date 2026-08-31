import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from './superadmin-allowlist';

const LIST = 'sfs@enhance-it.dk, Second@Example.com ';

describe('parseAllowlist', () => {
  it('splits, trims and lowercases', () => {
    expect(parseAllowlist(LIST)).toEqual(['sfs@enhance-it.dk', 'second@example.com']);
  });
  it('is empty for undefined, empty and whitespace', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
  it('drops empty entries from stray commas', () => {
    expect(parseAllowlist('a@b.com,,')).toEqual(['a@b.com']);
  });
});

describe('isAllowed', () => {
  it('accepts an exact match regardless of case or padding', () => {
    expect(isAllowed('sfs@enhance-it.dk', LIST)).toBe(true);
    expect(isAllowed('  SFS@Enhance-It.DK  ', LIST)).toBe(true);
  });

  // Each of the following is a plausible refactor, which is why each is a test.

  // Split into three separate assertions (rather than one it() with three
  // expects) deliberately: Vitest stops at the first failing expect, so
  // under the Step-5-style mutation proof (flip the empty-list return to
  // true) a single combined test would only ever report ONE failing name
  // even though all three branches are broken. Three tests means the
  // mutation proof names all three.
  it('DENIES everyone when the allowlist is undefined', () => {
    expect(isAllowed('sfs@enhance-it.dk', undefined)).toBe(false);
  });
  it('DENIES everyone when the allowlist is an empty string', () => {
    expect(isAllowed('sfs@enhance-it.dk', '')).toBe(false);
  });
  it('DENIES everyone when the allowlist is whitespace only', () => {
    expect(isAllowed('sfs@enhance-it.dk', '   ')).toBe(false);
  });
  it('denies a suffix attack on the domain', () => {
    expect(isAllowed('sfs@enhance-it.dk.evil.com', LIST)).toBe(false);
  });
  it('denies a bare domain', () => {
    expect(isAllowed('@enhance-it.dk', LIST)).toBe(false);
  });
  it('denies a substring of an allowed address', () => {
    expect(isAllowed('s@enhance-it.dk', LIST)).toBe(false);
    expect(isAllowed('enhance-it.dk', LIST)).toBe(false);
  });
  it('denies a prefix attack', () => {
    expect(isAllowed('evilsfs@enhance-it.dk', LIST)).toBe(false);
  });
  it('denies an undefined or empty email', () => {
    expect(isAllowed(undefined, LIST)).toBe(false);
    expect(isAllowed('', LIST)).toBe(false);
  });

  // toLowerCase() is not injective over Unicode: distinct code points can
  // fold to the same lowercase string. Both of these are constructed to
  // exploit that and must be rejected even though a naive lowercase
  // comparison would accept them.
  it('denies a Kelvin-sign homoglyph that lowercases to an allowed address', () => {
    // U+212A KELVIN SIGN lowercases to ASCII 'k', so this differs from
    // 'sfs@enhance-it.dk' only in that one character -- and would compare
    // equal to it after a plain .toLowerCase().
    expect(isAllowed('sfs@enhance-it.dK', LIST)).toBe(false);
  });
  it('denies a sharp-S homoglyph that is not actually the allowlisted address', () => {
    // U+1E9E LATIN CAPITAL LETTER SHARP S lowercases to U+00DF (ß), so this
    // input is not the string 'ß@x.com' yet would compare equal to it.
    expect(isAllowed('ẞ@x.com', 'ß@x.com')).toBe(false);
  });
});
