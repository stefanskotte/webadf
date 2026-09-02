import { describe, it, expect } from 'vitest';
import { normalizeQuery, escapeLike, likePattern, MAX_QUERY_LEN } from './search-query';

describe('normalizeQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeQuery('  giana   sisters ')).toBe('giana sisters');
  });

  it('caps length so one request cannot carry an essay', () => {
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(MAX_QUERY_LEN);
  });

  it('does NOT change case -- ILIKE is case-insensitive and pretending otherwise misleads', () => {
    expect(normalizeQuery('Giana')).toBe('Giana');
  });

  it('reduces a whitespace-only query to empty', () => {
    expect(normalizeQuery('   \t \n ')).toBe('');
  });
});

describe('escapeLike', () => {
  // Not a tenancy control -- orgFilter is a separate conjunct and a wildcard
  // cannot cross an org boundary. This stops ONE keystroke matching the
  // caller's whole library on an endpoint fired per character.
  it('escapes the LIKE metacharacters', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes the escape character FIRST, or the escapes get double-escaped', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Giana Sisters - Special Edition')).toBe('Giana Sisters - Special Edition');
  });
});

describe('likePattern', () => {
  it('wraps an escaped query in infix wildcards', () => {
    expect(likePattern('sisters')).toBe('%sisters%');
  });

  it('returns null for an empty query, so the caller can skip the database', () => {
    expect(likePattern('')).toBeNull();
    expect(likePattern('   ')).toBeNull();
  });

  it('a query that is only wildcards still cannot match everything', () => {
    expect(likePattern('%')).toBe('%\\%%');
  });
});
