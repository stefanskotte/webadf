import { describe, it, expect } from 'vitest';
import { splitKnownMissing } from './ingest';

describe('splitKnownMissing', () => {
  it('partitions requested hashes against what is already stored', () => {
    const r = splitKnownMissing(['a', 'b', 'c'], new Set(['b']));
    expect(r.known).toEqual(['b']);
    expect(r.missing).toEqual(['a', 'c']);
  });

  it('deduplicates repeated hashes in the request', () => {
    const r = splitKnownMissing(['a', 'a', 'b'], new Set());
    expect(r.missing).toEqual(['a', 'b']);
  });

  it('handles an empty request', () => {
    expect(splitKnownMissing([], new Set(['a']))).toEqual({ known: [], missing: [] });
  });
});
