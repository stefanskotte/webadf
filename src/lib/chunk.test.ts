import { describe, expect, it } from 'vitest';
import { chunk } from './chunk';

describe('chunk', () => {
  it('returns nothing for an empty array', () => {
    expect(chunk([], 500)).toEqual([]);
  });

  it('returns a single group when the input is under the limit', () => {
    expect(chunk([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it('returns exactly one group of size n when the input is exactly n', () => {
    const xs = Array.from({ length: 500 }, (_, i) => i);
    const groups = chunk(xs, 500);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(500);
  });

  // This is the exact shape of the bug: dropping one more file than the
  // server's MAX_BATCH cap must produce two requests, not one oversized
  // request that 400s.
  it('splits n+1 items into a full group and a group of one', () => {
    const xs = Array.from({ length: 501 }, (_, i) => i);
    const groups = chunk(xs, 500);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(500);
    expect(groups[1]).toHaveLength(1);
    expect(groups[1][0]).toBe(500);
  });

  it('splits a large collection (the real library is ~18,000 disks) into full-size groups', () => {
    const xs = Array.from({ length: 18_412 }, (_, i) => i);
    const groups = chunk(xs, 500);
    expect(groups).toHaveLength(37); // ceil(18412 / 500)
    expect(groups.slice(0, -1).every((g) => g.length === 500)).toBe(true);
    expect(groups.at(-1)).toHaveLength(18_412 - 36 * 500);
    expect(groups.flat()).toEqual(xs);
  });
});
