import { describe, it, expect } from 'vitest';
import { entitlementsToKeep } from './disk-delete';

describe('entitlementsToKeep', () => {
  it('keeps a sha a current disk points at', () => {
    expect(entitlementsToKeep(['a'], []).has('a')).toBe(true);
  });

  it('keeps a sha the org\'s history names as a version\'s image', () => {
    // Disks D and E share S0, D is edited (history v0 = S0), E is deleted:
    // no current disk names S0, but D's history does.
    expect(entitlementsToKeep([], [{ blob: 's0', image: 's0' }]).has('s0')).toBe(true);
  });

  it('keeps a sha the org\'s history names only as a version\'s blob', () => {
    const keep = entitlementsToKeep([], [{ blob: 'delta', image: 'img' }]);
    expect([...keep].sort()).toEqual(['delta', 'img']);
  });

  it('releases what neither a disk nor the history names', () => {
    const keep = entitlementsToKeep(['a'], [{ blob: 'b', image: 'c' }]);
    expect(['a', 'b', 'c', 'd'].filter((s) => !keep.has(s))).toEqual(['d']);
  });
});
