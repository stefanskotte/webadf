import { describe, it, expect } from 'vitest';
import { splitKnownMissing, stableId } from './ingest';

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

describe('stableId', () => {
  it('is deterministic for the same parts', () => {
    expect(stableId('game', 'org-1', 'turrican, the', '1990'))
      .toBe(stableId('game', 'org-1', 'turrican, the', '1990'));
  });

  it('differs when orgId differs, so two tenants never collide', () => {
    const idOrg1 = stableId('game', 'org-1', 'turrican, the', '1990');
    const idOrg2 = stableId('game', 'org-2', 'turrican, the', '1990');
    expect(idOrg1).not.toBe(idOrg2);
  });

  it('cannot be forged by shifting a boundary between parts', () => {
    // Without a separator that can't appear in the parts themselves,
    // ('ab', 'c') and ('a', 'bc') would collide.
    expect(stableId('ab', 'c')).not.toBe(stableId('a', 'bc'));
  });
});
