import { describe, it, expect } from 'vitest';

/**
 * The miss-rate arithmetic on /admin/scan, extracted so it can be tested
 * without a database.
 *
 * Kept in step with the page by hand -- the page holds the same three lines.
 * If they ever diverge, the page is the one that is right and this is the one
 * that is wrong.
 */
function missRate(s: {
  matched: number; none: number; ambiguous: number;
  unreadable: number; authoredNone: number;
}) {
  const unreadableDecided = Math.min(s.unreadable, s.none);
  const authoredDecided = Math.min(s.authoredNone, Math.max(0, s.none - unreadableDecided));
  const excluded = unreadableDecided + authoredDecided;
  const genuineNone = s.none - excluded;
  const decided = s.matched + s.none + s.ambiguous - excluded;
  return { rate: decided === 0 ? null : Math.round((genuineNone / decided) * 100), decided, excluded };
}

const base = { matched: 45, none: 55, ambiguous: 0, unreadable: 0, authoredNone: 0 };

describe('the TOSEC miss rate', () => {
  it('reports a genuine miss', () => {
    expect(missRate(base).rate).toBe(55);
  });

  it('does not move when a disk somebody MADE is unmatched', () => {
    // The whole point. A self-made disk is in no preservation set, so it is
    // neither a hit nor a miss -- it is not part of the question.
    const before = missRate(base).rate;
    const after = missRate({ ...base, none: 56, authoredNone: 1 }).rate;
    expect(after).toBe(before);
  });

  it('still moves when a REAL upload goes unmatched', () => {
    // The correction must not swallow the signal it exists to protect.
    expect(missRate({ ...base, none: 65 }).rate).toBeGreaterThan(missRate(base).rate!);
  });

  it('excludes unreadable and authored blobs together without double counting', () => {
    const r = missRate({ matched: 10, none: 10, ambiguous: 0, unreadable: 3, authoredNone: 2 });
    expect(r.excluded).toBe(5);
    expect(r.decided).toBe(15);
    expect(r.rate).toBe(Math.round((5 / 15) * 100));
  });

  it('cannot drive the count negative when the corrections overlap', () => {
    // Both counts are computed independently, so nothing stops them summing
    // past `none` -- a blob that is both unreadable and authored, say.
    const r = missRate({ matched: 0, none: 2, ambiguous: 0, unreadable: 2, authoredNone: 2 });
    expect(r.excluded).toBe(2);
    expect(r.decided).toBe(0);
    expect(r.rate).toBeNull();
  });

  it('says nothing rather than 0% when nothing has been decided', () => {
    expect(missRate({ matched: 0, none: 0, ambiguous: 0, unreadable: 0, authoredNone: 0 }).rate).toBeNull();
  });
});
