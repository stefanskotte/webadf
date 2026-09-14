import type { CopyRow } from './copy';
import { titleKey } from './title-key';

export const WANTED_TABLES: ReadonlySet<string> = new Set([
  'platforms_platform', 'productions_production', 'productions_production_platforms',
  'productions_production_types', 'productions_productiontype',
  'productions_production_author_nicks', 'demoscene_nick', 'productions_screenshot',
]);

export const MAX_SCREENSHOTS = 5;

export interface DemozooProductionRow {
  id: number; title: string; titleKey: string; releaseYear: number | null;
  supertype: string; types: string[]; groups: string[]; isGame: boolean;
}
export interface DemozooScreenshotRow { id: number; productionId: number; standardUrl: string; ordinal: number }
export interface DemozooExtract { productions: DemozooProductionRow[]; screenshots: DemozooScreenshotRow[] }

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/**
 * Order-independent on purpose: every table is buffered by id and joined at
 * the end, so it does not rely on pg_dump's table order.
 */
export async function extractAmiga(rows: AsyncIterable<CopyRow>): Promise<DemozooExtract> {
  const amigaPlatforms = new Set<string>();
  const platformsOf = new Map<string, string[]>();
  const base = new Map<string, { title: string; date: string | null; supertype: string }>();
  const typeIdsOf = new Map<string, string[]>();
  const typeName = new Map<string, string>();
  const nickIdsOf = new Map<string, string[]>();
  const nickName = new Map<string, string>();
  const shotsOf = new Map<string, Array<{ id: number; url: string }>>();

  for await (const { table, row } of rows) {
    switch (table) {
      case 'platforms_platform':
        if (/amiga/i.test(row.name ?? '')) amigaPlatforms.add(row.id!);
        break;
      case 'productions_production':
        base.set(row.id!, { title: row.title ?? '', date: row.release_date_date, supertype: row.supertype ?? '' });
        break;
      case 'productions_production_platforms':
        push(platformsOf, row.production_id!, row.platform_id!);
        break;
      case 'productions_production_types':
        push(typeIdsOf, row.production_id!, row.productiontype_id!);
        break;
      case 'productions_productiontype':
        typeName.set(row.id!, row.name ?? '');
        break;
      case 'productions_production_author_nicks':
        push(nickIdsOf, row.production_id!, row.nick_id!);
        break;
      case 'demoscene_nick':
        nickName.set(row.id!, row.name ?? '');
        break;
      case 'productions_screenshot':
        if (row.standard_url) push(shotsOf, row.production_id!, { id: Number(row.id), url: row.standard_url });
        break;
    }
  }

  const productions: DemozooProductionRow[] = [];
  const screenshots: DemozooScreenshotRow[] = [];
  const ids = [...platformsOf.keys()]
    .filter((id) => platformsOf.get(id)!.some((p) => amigaPlatforms.has(p)) && base.has(id))
    .sort((a, b) => Number(a) - Number(b));

  for (const id of ids) {
    const b = base.get(id)!;
    const types = (typeIdsOf.get(id) ?? []).map((t) => typeName.get(t)).filter((t): t is string => !!t);
    const groups = [...new Set((nickIdsOf.get(id) ?? []).map((n) => nickName.get(n)).filter((n): n is string => !!n))];
    const year = b.date ? Number(b.date.slice(0, 4)) : NaN;
    productions.push({
      id: Number(id), title: b.title, titleKey: titleKey(b.title),
      releaseYear: Number.isFinite(year) ? year : null,
      supertype: b.supertype, types, groups, isGame: types.includes('Game'),
    });
    const shots = (shotsOf.get(id) ?? []).sort((p, q) => p.id - q.id).slice(0, MAX_SCREENSHOTS);
    shots.forEach((s, i) => screenshots.push({ id: s.id, productionId: Number(id), standardUrl: s.url, ordinal: i + 1 }));
  }
  return { productions, screenshots };
}
