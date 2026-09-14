import { parseTosecName } from '@/lib/tosec';
import { titleKey } from './title-key';

export type SuggestionSource = 'tosec_title' | 'volume_name' | 'filename';
export interface DemozooCandidate {
  id: number; title: string; releaseYear: number | null; groups: string[];
  supertype: string; isGame: boolean;
}
export interface TosecIdentity { setName: string; title: string; year: number | null; publisher: string | null }
export interface MatchInput { tosec: TosecIdentity | null; volumeName: string | null; filenames: string[] }
export type MatchVerdict =
  | { state: 'skipped_game' }
  | { state: 'applied'; productionId: number }
  | { state: 'suggested'; suggestions: Array<{ productionId: number; source: SuggestionSource }> }
  | { state: 'none' };

/** TOSEC's `Games` and `Games - Public Domain` sets. Demozoo never answers for these. */
export const isGameSet = (setName: string) => setName.includes('- Games -');

/** spec §5.2 */
export const isCandidate = (c: DemozooCandidate) => c.supertype === 'production' && !c.isGame;

export function groupsAgree(publisher: string, groups: string[]): boolean {
  const p = titleKey(publisher);
  if (!p) return false;
  return groups.some((g) => { const k = titleKey(g); return k.length > 0 && (k.includes(p) || p.includes(k)); });
}

export function matchKeys(input: MatchInput): string[] {
  const keys = [
    input.tosec ? titleKey(input.tosec.title) : '',
    input.volumeName ? titleKey(input.volumeName) : '',
    ...input.filenames.map((f) => titleKey(parseTosecName(f).title)),
  ];
  return [...new Set(keys.filter((k) => k.length > 0))];
}

export function decideDemozoo(input: MatchInput, lookup: (key: string) => DemozooCandidate[]): MatchVerdict {
  const t = input.tosec;
  if (t && isGameSet(t.setName)) return { state: 'skipped_game' };

  if (t) {
    const key = titleKey(t.title);
    const cands = key ? lookup(key).filter(isCandidate) : [];
    if (cands.length === 1) {
      const c = cands[0];
      const yearOk = t.year !== null && c.releaseYear === t.year;
      const groupOk = t.publisher !== null && groupsAgree(t.publisher, c.groups);
      if (yearOk || groupOk) return { state: 'applied', productionId: c.id };
    }
    if (cands.length > 0) {
      return { state: 'suggested', suggestions: cands.map((c) => ({ productionId: c.id, source: 'tosec_title' as const })) };
    }
  }

  const found = new Map<number, SuggestionSource>();
  const add = (raw: string, source: SuggestionSource) => {
    const key = titleKey(raw);
    if (!key) return;
    for (const c of lookup(key).filter(isCandidate)) if (!found.has(c.id)) found.set(c.id, source);
  };
  if (input.volumeName) add(input.volumeName, 'volume_name');
  for (const f of input.filenames) add(parseTosecName(f).title, 'filename');

  if (found.size === 0) return { state: 'none' };
  return { state: 'suggested', suggestions: [...found].map(([productionId, source]) => ({ productionId, source })) };
}
