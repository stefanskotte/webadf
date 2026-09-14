import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCopyBlocks } from './copy';
import { textLines } from './lines';
import { extractAmiga, WANTED_TABLES } from './extract';
import { decideDemozoo, groupsAgree, matchKeys, type DemozooCandidate } from './match';

const DEMOS = 'Commodore Amiga - Demos - Various - [ADF]';
const GAMES = 'Commodore Amiga - Games - [ADF]';

let lookup: (key: string) => DemozooCandidate[];
beforeAll(async () => {
  const text = readFileSync(join(__dirname, 'fixtures', 'excerpt.sql'), 'utf8');
  const x = await extractAmiga(readCopyBlocks(textLines(text), WANTED_TABLES));
  const byKey = new Map<string, DemozooCandidate[]>();
  for (const p of x.productions) byKey.set(p.titleKey, [...(byKey.get(p.titleKey) ?? []), p]);
  lookup = (k) => byKey.get(k) ?? [];
});

const tosec = (title: string, year: number | null = null, publisher: string | null = null, setName = DEMOS) =>
  ({ tosec: { setName, title, year, publisher }, volumeName: null, filenames: [] });

describe('decideDemozoo — the spike cases (spec §10)', () => {
  it('Ray of Hope 2 with TOSEC year and group is applied automatically', () => {
    expect(decideDemozoo(tosec('Ray of Hope 2', 1991, 'Majic 12'), lookup))
      .toEqual({ state: 'applied', productionId: 737 });
  });

  it('a unique match with nothing to verify is only a suggestion', () => {
    expect(decideDemozoo(tosec('9 Fingers'), lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 89, source: 'tosec_title' }] });
    expect(decideDemozoo(tosec('Wayfarer'), lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 4162, source: 'tosec_title' }] });
    expect(decideDemozoo(tosec('Global Trash'), lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 710, source: 'tosec_title' }] });
  });

  it('State of the Art resolves to the Spaceballs demo; the Glide music entry is not a candidate', () => {
    expect(decideDemozoo(tosec('State of the Art', 1992, 'Spaceballs'), lookup))
      .toEqual({ state: 'applied', productionId: 2 });
  });

  it('a TOSEC game is skipped, even though its title matches a cracktro', () => {
    expect(decideDemozoo(tosec('Alien Breed II: The Horror Continues', 1993, 'Team17', GAMES), lookup))
      .toEqual({ state: 'skipped_game' });
    expect(decideDemozoo(tosec('Lemmings', 1991, 'Psygnosis', 'Commodore Amiga - Games - Public Domain - [ADF]'), lookup))
      .toEqual({ state: 'skipped_game' });
  });

  it('the "Millions" shape: unique title, group and year disagree -> suggestion, not applied', () => {
    const fake: DemozooCandidate = { id: 207031, title: 'Millions', releaseYear: 1993, groups: ['Abyss'], supertype: 'production', isGame: false };
    const v = decideDemozoo(tosec('Millions', 1994, 'Beyond'), (k) => (k === 'millions' ? [fake] : []));
    expect(v).toEqual({ state: 'suggested', suggestions: [{ productionId: 207031, source: 'tosec_title' }] });
  });

  it('a production typed Game is never a candidate', () => {
    const g: DemozooCandidate = { id: 1, title: 'Scene Game', releaseYear: 1994, groups: ['X'], supertype: 'production', isGame: true };
    expect(decideDemozoo(tosec('Scene Game', 1994, 'X'), () => [g])).toEqual({ state: 'none' });
  });
});

describe('decideDemozoo — disks TOSEC does not know', () => {
  it('suggests from the volume name', () => {
    expect(decideDemozoo({ tosec: null, volumeName: 'Wayfarer', filenames: [] }, lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 4162, source: 'volume_name' }] });
  });
  it('suggests from a filename stem, parsed as TOSEC does', () => {
    expect(decideDemozoo({ tosec: null, volumeName: null, filenames: ['9 Fingers (1993)(Spaceballs).adf'] }, lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 89, source: 'filename' }] });
  });
  it('never automatic without TOSEC, and none when nothing matches', () => {
    expect(decideDemozoo({ tosec: null, volumeName: 'Workbench3.1', filenames: ['amiga-wb31_workbench.adf'] }, lookup))
      .toEqual({ state: 'none' });
  });
  it('a TOSEC non-game with no title hit falls through to names', () => {
    expect(decideDemozoo({ tosec: { setName: DEMOS, title: 'Unknown Thing', year: null, publisher: null }, volumeName: 'Global Trash', filenames: [] }, lookup))
      .toEqual({ state: 'suggested', suggestions: [{ productionId: 710, source: 'volume_name' }] });
  });
});

describe('groupsAgree / matchKeys', () => {
  it('agrees on containment either way, never on empty keys', () => {
    expect(groupsAgree('Majic 12', ['Majic 12'])).toBe(true);
    expect(groupsAgree('Silents', ['The Silents'])).toBe(true);
    expect(groupsAgree('Beyond', ['Abyss'])).toBe(false);
    expect(groupsAgree('!!!', ['Anything'])).toBe(false);
  });
  it('collects every distinct non-empty key', () => {
    expect(matchKeys({ tosec: { setName: DEMOS, title: 'Wayfarer', year: null, publisher: null }, volumeName: 'Wayfarer', filenames: ['x.adf'] }))
      .toEqual(['wayfarer', 'x']);
  });
});
