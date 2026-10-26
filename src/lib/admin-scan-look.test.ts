import { describe, it, expect } from 'vitest';
import { scanCoverage, enrichCoverage, scanNotes, plural } from '@/lib/admin-scan-look';

describe('scanCoverage (C6 spec §5.6, Ruling 22): the page arithmetic, moved verbatim', () => {
  it('takes the unreadable and self-made blobs out of `none` and out of `decided`', () => {
    const c = scanCoverage({ matched: 46, none: 50, ambiguous: 4, unreadable: 2, authoredNone: 3 });
    expect(c).toMatchObject({ decided: 95, matched: 46, genuineNone: 45, authoredDecided: 3, recognisedPct: 48 });
    expect(c.okW).toBeCloseTo((46 / 95) * 100, 6);
    expect(c.missW).toBeCloseTo((45 / 95) * 100, 6);
  });
  it('the min() caps: more unreadable than none, and self-made capped by what is left', () => {
    const c = scanCoverage({ matched: 10, none: 4, ambiguous: 1, unreadable: 9, authoredNone: 5 });
    expect(c).toMatchObject({ genuineNone: 0, authoredDecided: 0, decided: 11 });
    expect(scanCoverage({ matched: 0, none: 6, ambiguous: 0, unreadable: 2, authoredNone: 9 }))
      .toMatchObject({ authoredDecided: 4, genuineNone: 0, decided: 0, recognisedPct: null });
  });
  it('nothing decided: no percentage and empty bars', () => {
    expect(scanCoverage({ matched: 0, none: 0, ambiguous: 0, unreadable: 0, authoredNone: 0 }))
      .toEqual({ decided: 0, matched: 0, genuineNone: 0, authoredDecided: 0, recognisedPct: null, okW: 0, missW: 0 });
  });
});

describe('enrichCoverage', () => {
  it('enriched over enriched + not in OpenRetro + ambiguous', () => {
    expect(enrichCoverage({ enriched: 30, enrichNone: 8, enrichAmbiguous: 2 }))
      .toMatchObject({ decided: 40, matched: 30, genuineNone: 8, authoredDecided: 0, recognisedPct: 75, okW: 75, missW: 20 });
    expect(enrichCoverage({ enriched: 0, enrichNone: 0, enrichAmbiguous: 0 }).recognisedPct).toBeNull();
  });
});

describe('scanNotes (C6 spec §5.3, Ruling 24)', () => {
  const quiet = { unchecked: 0, unreadable: 0, openretroEntries: 100, enrichUnchecked: 0 };
  it('done, and only done, when nothing is left', () => {
    expect(scanNotes(quiet)).toEqual([{ kind: 'done', text: 'Every blob is processed; the nightly run picks up new uploads.' }]);
  });
  it('every note that applies, in order, with the board words', () => {
    expect(scanNotes({ unchecked: 3, unreadable: 12, openretroEntries: 0, enrichUnchecked: 40 })).toEqual([
      { kind: 'unchecked', text: '3 blobs still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.' },
      { kind: 'unreadable', text: '12 blobs could not be read from storage and were stamped hashed with no hash — they always report as no match, not a genuine TOSEC miss.' },
      { kind: 'no-openretro', text: 'No OpenRetro metadata loaded. Nothing can be enriched until an Amiga.sqlite is uploaded below.' },
    ]);
    expect(scanNotes({ ...quiet, enrichUnchecked: 40 })).toEqual([
      { kind: 'enrich', text: '40 blobs still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.' },
    ]);
  });
  it('one blob reads in the singular', () => {
    expect(scanNotes({ unchecked: 1, unreadable: 1, openretroEntries: 5, enrichUnchecked: 1 }).map((n) => n.text)).toEqual([
      '1 blob still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.',
      '1 blob could not be read from storage and was stamped hashed with no hash — it always reports as no match, not a genuine TOSEC miss.',
      '1 blob still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.',
    ]);
  });
  it('plural', () => {
    expect(plural(1, 'disk', 'disks')).toBe('disk');
    expect(plural(0, 'disk', 'disks')).toBe('disks');
    expect(plural(2, 'disk', 'disks')).toBe('disks');
  });
  it('never rounds up to 100% recognised while a miss remains', () => {
    expect(scanCoverage({ matched: 995, none: 5, ambiguous: 0, unreadable: 0, authoredNone: 0 }).recognisedPct).toBe(99);
  });
});
