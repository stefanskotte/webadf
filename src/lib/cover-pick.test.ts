import { describe, it, expect } from 'vitest';
import { pickCover, type CoverCandidate } from './cover-pick';

const img = (kind: string, ordinal = 0, sha1 = kind + ordinal): CoverCandidate =>
  ({ sha1, kind, ordinal });

describe('pickCover', () => {
  it('returns null when a game has no images at all', () => {
    // The common case by far: OpenRetro recognises 4 of 61 real disks, so
    // most cards keep their gradient and must not break trying.
    expect(pickCover([])).toBeNull();
  });

  it('prefers the front cover over everything else', () => {
    const chosen = pickCover([img('screenshot', 1), img('title'), img('front')]);
    expect(chosen?.kind).toBe('front');
  });

  it('falls back to the title screen when there is no front cover', () => {
    expect(pickCover([img('screenshot', 2), img('title')])?.kind).toBe('title');
  });

  it('falls back to the lowest-ordinal screenshot when there is neither', () => {
    // Ordinal, not insertion order: the sweeper stores screenshots as it
    // fetches them and a retry can land them out of order.
    const chosen = pickCover([img('screenshot', 3), img('screenshot', 1), img('screenshot', 2)]);
    expect(chosen?.ordinal).toBe(1);
  });

  it('ignores a kind it does not recognise rather than showing it', () => {
    // openretro_images.kind is a plain text column with no constraint, so a
    // future kind (a banner, a box back) must not silently become the cover.
    expect(pickCover([img('banner'), img('back', 1)])).toBeNull();
  });

  it('is deterministic when two images tie on kind and ordinal', () => {
    // Two rows can genuinely tie; the grid must not reshuffle between renders.
    const a = { sha1: 'bbb', kind: 'screenshot', ordinal: 1 };
    const b = { sha1: 'aaa', kind: 'screenshot', ordinal: 1 };
    expect(pickCover([a, b])?.sha1).toBe(pickCover([b, a])?.sha1);
  });
});
