import { describe, it, expect } from 'vitest';
import { chooseMosaic, mosaicCandidates, MOSAIC_TILES, MOSAIC_CANDIDATES } from './collection-mosaic';

const covers = (map: Record<string, string>) => (id: string) => map[id];

describe('chooseMosaic', () => {
  it('takes the first four covers in membership order', () => {
    const chosen = chooseMosaic(['a', 'b', 'c', 'd', 'e'], covers({
      a: '/api/images/1', b: '/api/images/2', c: '/api/images/3',
      d: '/api/images/4', e: '/api/images/5',
    }));
    expect(chosen).toEqual(['/api/images/1', '/api/images/2', '/api/images/3', '/api/images/4']);
    expect(chosen).toHaveLength(MOSAIC_TILES);
  });

  it('skips titles with no cover rather than stopping at them', () => {
    // The ordinary case for a real archive: most titles are unidentified, so a
    // mosaic that gave up at the first gap would almost always be empty.
    const chosen = chooseMosaic(['a', 'b', 'c', 'd', 'e', 'f'], covers({
      c: '/api/images/3', f: '/api/images/6',
    }));
    expect(chosen).toEqual(['/api/images/3', '/api/images/6']);
  });

  it('never tiles the same picture twice', () => {
    const chosen = chooseMosaic(['a', 'b', 'c'], covers({
      a: '/api/images/same', b: '/api/images/same', c: '/api/images/other',
    }));
    expect(chosen).toEqual(['/api/images/same', '/api/images/other']);
  });

  it('answers empty for a collection with nothing to show', () => {
    expect(chooseMosaic(['a', 'b'], covers({}))).toEqual([]);
    expect(chooseMosaic([], covers({ a: '/api/images/1' }))).toEqual([]);
  });

  it('stops looking once it has its tiles', () => {
    // Not just "returns 4": it must not keep calling for the rest, which is
    // what makes the candidate cap above it meaningful.
    const asked: string[] = [];
    const chosen = chooseMosaic(['a', 'b', 'c', 'd', 'e', 'f'], (id) => {
      asked.push(id);
      return `/api/images/${id}`;
    });
    expect(chosen).toHaveLength(4);
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('mosaicCandidates', () => {
  it('caps each collection independently, keeping order', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ collectionId: 'big', gameId: `g${i}` })),
      { collectionId: 'small', gameId: 'x' },
    ];
    const candidates = mosaicCandidates(rows);
    expect(candidates.get('big')).toHaveLength(MOSAIC_CANDIDATES);
    expect(candidates.get('big')?.[0]).toBe('g0');
    expect(candidates.get('big')?.at(-1)).toBe(`g${MOSAIC_CANDIDATES - 1}`);
    expect(candidates.get('small')).toEqual(['x']);
  });

  it('looks deeper than it will ever show, so a run of unidentified titles cannot empty a mosaic', () => {
    expect(MOSAIC_CANDIDATES).toBeGreaterThan(MOSAIC_TILES);
  });

  it('has no entry for a collection with no members', () => {
    expect(mosaicCandidates([]).size).toBe(0);
  });
});
