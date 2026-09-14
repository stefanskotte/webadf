import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCopyBlocks } from './copy';
import { textLines } from './lines';
import { extractAmiga, WANTED_TABLES, MAX_SCREENSHOTS, type DemozooExtract } from './extract';

// Real rows cut from the 2026-09-14 export by scripts/demozoo-excerpt.ts.
let x: DemozooExtract;
beforeAll(async () => {
  const text = readFileSync(join(__dirname, 'fixtures', 'excerpt.sql'), 'utf8');
  x = await extractAmiga(readCopyBlocks(textLines(text), WANTED_TABLES));
});
const prod = (id: number) => x.productions.find((p) => p.id === id);

describe('extractAmiga on real Demozoo rows', () => {
  it('keeps the eight Amiga productions and drops the non-Amiga one', () => {
    expect(x.productions.map((p) => p.id).sort((a, b) => a - b))
      .toEqual([2, 89, 710, 737, 4162, 188557, 218264, 243512]);
  });

  // SPEC §10: a real production with several types and several authors.
  it('resolves every type and every author for a multi-type, multi-author production', () => {
    expect(prod(188557)).toMatchObject({ title: 'Megademo 4' });
    expect(prod(188557)!.types).toEqual(expect.arrayContaining(['Demo', 'Pack']));
    expect(prod(188557)!.types.length).toBeGreaterThanOrEqual(2);
    expect(prod(188557)!.groups).toEqual(expect.arrayContaining(['Kefrens', '7up Crew']));
    expect(prod(188557)!.groups.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves titles, years and groups (the spike\'s own readings)', () => {
    expect(prod(89)).toMatchObject({ title: '9 Fingers', releaseYear: 1993, titleKey: '9fingers' });
    expect(prod(89)!.groups).toContain('Spaceballs');
    expect(prod(737)).toMatchObject({ title: 'Ray of Hope 2', releaseYear: 1991 });
    expect(prod(737)!.groups).toContain('Majic 12');
    expect(prod(710)!.groups).toContain('The Silents');
  });

  it('types come from productiontype names', () => {
    expect(prod(89)!.types).toContain('Demo');
    expect(prod(243512)!.types).toContain('Cracktro');
  });

  // SPEC §5.2 "Unverified": if this fails, STOP and report to the operator --
  // the candidate filter rests on it.
  it('the Glide "state-of-the-art" entry is not a production-supertype', () => {
    expect(prod(218264)!.supertype).not.toBe('production');
  });

  it('isGame is false for demos', () => expect(prod(89)!.isGame).toBe(false));

  it('keeps at most MAX_SCREENSHOTS per production, ordinals from 1', () => {
    const byProd = new Map<number, number[]>();
    for (const s of x.screenshots) byProd.set(s.productionId, [...(byProd.get(s.productionId) ?? []), s.ordinal]);
    for (const ords of byProd.values()) {
      expect(ords.length).toBeLessThanOrEqual(MAX_SCREENSHOTS);
      expect([...ords].sort((a, b) => a - b)).toEqual(ords.map((_, i) => i + 1));
    }
    expect(x.screenshots.every((s) => s.standardUrl.startsWith('http'))).toBe(true);
  });
});
