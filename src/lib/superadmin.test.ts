import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from './superadmin';

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

  it('DENIES everyone when the allowlist is unset or empty', () => {
    expect(isAllowed('sfs@enhance-it.dk', undefined)).toBe(false);
    expect(isAllowed('sfs@enhance-it.dk', '')).toBe(false);
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
});
