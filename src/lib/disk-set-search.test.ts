// Fake db in the style of disk-set-store.test.ts: reads answer from a
// per-table queue, and each select's WHERE (and JOIN ON) is kept as a REAL
// drizzle SQL object so the rendered statement -- org scoping, the
// exactly-one-disk guard, the ILIKE escaping -- can be asserted on its own
// shape, not trusted from the TypeScript that built it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { games, disks } from '@/db/schema/catalog';

type Sel = { table: unknown; where: SQL | undefined; joins: SQL[]; order: SQL[]; limit: number | undefined };
let byTable: Map<unknown, unknown[][]>;
let selects: Sel[];

const fakeDb = {
  select: () => {
    const q: Sel = { table: undefined, where: undefined, joins: [], order: [], limit: undefined };
    const chain = {
      from: (t: unknown) => { q.table = t; return chain; },
      innerJoin: (_t: unknown, on: SQL) => { q.joins.push(on); return chain; },
      leftJoin: (_t: unknown, on: SQL) => { q.joins.push(on); return chain; },
      where: (w: SQL) => { q.where = w; return chain; },
      orderBy: (...o: SQL[]) => { q.order.push(...o); return chain; },
      limit: (n: number) => { q.limit = n; return chain; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        selects.push(q);
        return Promise.resolve(byTable.get(q.table)?.shift() ?? []).then(res, rej);
      },
    };
    return chain;
  },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

// bytes are just the sha re-encoded, so readVolume's mock can tell which
// disk it was asked to read without any real ADF ever existing.
const read = vi.fn(async (sha: string) => new TextEncoder().encode(sha));
vi.mock('@/lib/storage', () => ({ diskStore: { read: (s: string) => read(s) } }));

const volumeFor = new Map<string, { ok: true; volume: { name: string } } | { ok: false; reason: string }>();
const readVolume = vi.fn((bytes: Uint8Array) => {
  const sha = new TextDecoder().decode(bytes);
  return volumeFor.get(sha) ?? { ok: false, reason: 'not-adf' };
});
vi.mock('@/lib/adffs', () => ({ readVolume: (b: Uint8Array) => readVolume(b) }));

const suggestSet = vi.fn();
vi.mock('@/lib/disk-set-suggest', () => ({ suggestSet: (i: unknown) => suggestSet(i) }));

const { suggestFromUpload, searchCandidates } = await import('./disk-set-search');

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);
function answer(t: unknown, ...rows: unknown[][]) { byTable.set(t, rows); }

beforeEach(() => {
  byTable = new Map(); selects = [];
  read.mockClear(); readVolume.mockClear(); volumeFor.clear(); suggestSet.mockReset();
});

describe('suggestFromUpload', () => {
  it('scopes the query to the session org, the requested hashes, the since floor, the human-order gate and the lone-disk guard', async () => {
    answer(disks, []);
    await suggestFromUpload('org-1', ['a'.repeat(64)], new Date('2026-09-28T00:00:00Z'), undefined);

    expect(selects).toHaveLength(1);
    expect(selects[0].table).toBe(disks);
    const where = render(selects[0].where!);
    expect(where.sql).toMatch(/"disks"\."org_id" = \$\d+/);
    expect(where.sql).toMatch(/"disks"\."sha256" in \(\$\d+\)/);
    expect(where.sql).toMatch(/"games"\."created_at" >= \$\d+/);
    expect(where.sql).toMatch(/"games"\."disk_order_source" is null/);
    // The guard: a game with any OTHER disk is never suggested, whatever the
    // upload's own hashes say.
    expect(where.sql).toMatch(/\(select count\(\*\) from disks d2 where d2\.game_id = "games"\."id" and d2\.org_id = \$\d+\) = 1/);
    expect(where.params).toEqual(expect.arrayContaining(['org-1', 'a'.repeat(64)]));

    // Both joins are ALSO org-scoped, not just gameId/sha256 (disks.orgId can
    // drift from its game's -- src/lib/search.ts's header).
    expect(selects[0].joins).toHaveLength(2);
    const [gamesJoin, entJoin] = selects[0].joins.map(render);
    expect(gamesJoin.sql).toMatch(/"games"\."id" = "disks"\."game_id"/);
    expect(gamesJoin.sql).toMatch(/"games"\."org_id" = \$\d+/);
    expect(gamesJoin.params).toContain('org-1');
    expect(entJoin.sql).toMatch(/"entitlements"\."sha256" = "disks"\."sha256"/);
    expect(entJoin.sql).toMatch(/"entitlements"\."org_id" = \$\d+/);
    expect(entJoin.params).toContain('org-1');
  });

  it('normalises a blank or whitespace-only volume label to null before calling suggestSet, but keeps a real one trimmed', async () => {
    const shaBlank = 'b'.repeat(64);
    const shaReal = 'c'.repeat(64);
    volumeFor.set(shaBlank, { ok: true, volume: { name: '   ' } });
    volumeFor.set(shaReal, { ok: true, volume: { name: '  Workbench  ' } });
    answer(disks, [
      { diskId: 'd1', gameId: 'g1', sha256: shaBlank, sourceFilename: 'Blank.adf', tosecName: null },
      { diskId: 'd2', gameId: 'g2', sha256: shaReal, sourceFilename: 'Real.adf', tosecName: null },
    ]);
    suggestSet.mockReturnValue(null);

    await suggestFromUpload('org-1', [shaBlank, shaReal], new Date(), { [shaReal]: 'sub/Real.adf' });

    expect(suggestSet).toHaveBeenCalledWith([
      { diskId: 'd1', gameId: 'g1', filename: 'Blank.adf', volumeName: null, relativePath: undefined },
      { diskId: 'd2', gameId: 'g2', filename: 'Real.adf', volumeName: 'Workbench', relativePath: 'sub/Real.adf' },
    ]);
  });

  it('hands suggestSet the rows in the order the client sent the hashes, tie-broken by disk id (I2)', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(64));
    // The database answers in its own order; the drop order was c, a, b.
    answer(disks, [
      { diskId: 'da', gameId: 'ga', sha256: a, sourceFilename: 'A.adf', tosecName: null },
      { diskId: 'db2', gameId: 'gb2', sha256: b, sourceFilename: 'B.adf', tosecName: null },
      { diskId: 'dc', gameId: 'gc', sha256: c, sourceFilename: 'C.adf', tosecName: null },
      { diskId: 'db1', gameId: 'gb1', sha256: b, sourceFilename: 'B.adf', tosecName: null },
    ]);
    suggestSet.mockReturnValue(null);
    await suggestFromUpload('org-1', [c, a, b], new Date(), undefined);
    expect(suggestSet.mock.calls[0][0].map((i: { diskId: string }) => i.diskId)).toEqual(['dc', 'da', 'db1', 'db2']);
  });

  it('compares created_at against since minus 5 minutes of slack for client clock skew (m3)', async () => {
    answer(disks, []);
    const since = new Date('2026-09-28T12:00:00.000Z');
    await suggestFromUpload('org-1', ['a'.repeat(64)], since, undefined);
    const where = render(selects[0].where!);
    const floor = where.params.find((p) => p instanceof Date || (typeof p === 'string' && /^2026-09-28T/.test(p)));
    expect(new Date(floor as string | Date).toISOString()).toBe('2026-09-28T11:55:00.000Z');
  });

  it('a disk whose image cannot be read gets a null volume name, never a throw', async () => {
    const sha = 'd'.repeat(64);
    read.mockRejectedValueOnce(new Error('store unavailable'));
    answer(disks, [{ diskId: 'd1', gameId: 'g1', sha256: sha, sourceFilename: 'X.adf', tosecName: null }]);
    suggestSet.mockReturnValue(null);

    await suggestFromUpload('org-1', [sha], new Date(), undefined);
    expect(suggestSet).toHaveBeenCalledWith([
      { diskId: 'd1', gameId: 'g1', filename: 'X.adf', volumeName: null, relativePath: undefined },
    ]);
  });

  it('falls back to the catalog filename when the entitlement is missing, and returns what suggestSet returns', async () => {
    const sha = 'e'.repeat(64);
    answer(disks, [{ diskId: 'd1', gameId: 'g1', sha256: sha, sourceFilename: null, tosecName: 'Fallback.adf' }]);
    const suggestion = { name: 'X set', disks: [] };
    suggestSet.mockReturnValue(suggestion);

    const result = await suggestFromUpload('org-1', [sha], new Date(), undefined);
    expect(suggestSet).toHaveBeenCalledWith([
      { diskId: 'd1', gameId: 'g1', filename: 'Fallback.adf', volumeName: null, relativePath: undefined },
    ]);
    expect(result).toBe(suggestion);
  });

  it('two disk rows sharing one hash (the same bytes under two filenames) read the store exactly once', async () => {
    const sha = 'f'.repeat(64);
    volumeFor.set(sha, { ok: true, volume: { name: 'Shared' } });
    answer(disks, [
      { diskId: 'd1', gameId: 'g1', sha256: sha, sourceFilename: 'One.adf', tosecName: null },
      { diskId: 'd2', gameId: 'g2', sha256: sha, sourceFilename: 'Two.adf', tosecName: null },
    ]);
    suggestSet.mockReturnValue(null);

    await suggestFromUpload('org-1', [sha], new Date(), undefined);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(sha);
    expect(suggestSet).toHaveBeenCalledWith([
      { diskId: 'd1', gameId: 'g1', filename: 'One.adf', volumeName: 'Shared', relativePath: undefined },
      { diskId: 'd2', gameId: 'g2', filename: 'Two.adf', volumeName: 'Shared', relativePath: undefined },
    ]);
  });

  it('more than 32 rows (shared hashes can outnumber the <=32 requested) returns null without reading anything', async () => {
    const rows = Array.from({ length: 33 }, (_, i) => ({
      diskId: `d${i}`, gameId: `g${i}`, sha256: 'a'.repeat(64), sourceFilename: `F${i}.adf`, tosecName: null,
    }));
    answer(disks, rows);

    const result = await suggestFromUpload('org-1', ['a'.repeat(64)], new Date(), undefined);

    expect(result).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(suggestSet).not.toHaveBeenCalled();
  });
});

describe('searchCandidates', () => {
  it('org-scopes and excludes the given title, ordered newest first, one page of 20 (+1 to see if there is more)', async () => {
    answer(games, []);
    await searchCandidates('org-1', '', 'G-self');

    const titleSel = selects.find((s) => s.table === games)!;
    const where = render(titleSel.where!);
    expect(where.sql).toMatch(/"games"\."org_id" = \$\d+/);
    expect(where.sql).toMatch(/"games"\."id" <> \$\d+/);
    expect(where.params).toEqual(expect.arrayContaining(['org-1', 'G-self']));
    // Empty q: no ILIKE/EXISTS predicate at all, not an unescaped '%%'.
    expect(where.sql).not.toMatch(/ilike/);
    expect(titleSel.limit).toBe(21);
    const orderSql = titleSel.order.map(render).map((r) => r.sql).join(', ');
    expect(orderSql).toMatch(/"games"\."created_at" desc/);
  });

  it('escapes % and _ in q so it cannot act as a wildcard, and matches title, tosec_name or source_filename', async () => {
    answer(games, []);
    await searchCandidates('org-1', '50%_off', null);

    const titleSel = selects.find((s) => s.table === games)!;
    const where = render(titleSel.where!);
    expect(where.sql).toMatch(/"games"\."title" ilike \$\d+/);
    expect(where.sql).toMatch(/exists \(/);
    expect(where.sql).toMatch(/"disks"\."tosec_name" ilike \$\d+/);
    expect(where.sql).toMatch(/"entitlements"\."source_filename" ilike \$\d+/);
    // Every disk/entitlement subquery is ALSO org-scoped.
    expect(where.sql).toMatch(/"disks"\."org_id" = \$\d+/);
    expect(where.sql).toMatch(/"entitlements"\."org_id" = \$\d+/);
    // The escaped, wildcard-wrapped pattern -- never the raw '%50%_off%'.
    expect(where.params).toContain('%50\\%\\_off%');
    expect(where.params).not.toContain('%50%_off%');
  });

  it('every returned title carries ALL of its disks, org-scoped, not only the ones a search matched', async () => {
    answer(games, [{ id: 'g1', title: 'Lemmings' }, { id: 'g2', title: 'Zool' }]);
    answer(disks,
      [
        { gameId: 'g1', id: 'd1', diskNo: 1, tosecName: 'Lemmings (Disk 1).adf', sourceFilename: 'Lemmings1.adf' },
        { gameId: 'g1', id: 'd2', diskNo: 2, tosecName: 'Lemmings (Disk 2).adf', sourceFilename: null },
        { gameId: 'g2', id: 'd3', diskNo: 1, tosecName: null, sourceFilename: 'Zool.adf' },
      ],
    );

    const { titles: result } = await searchCandidates('org-1', 'le', null);
    expect(result).toEqual([
      {
        gameId: 'g1', title: 'Lemmings',
        disks: [
          { id: 'd1', diskNo: 1, sourceFilename: 'Lemmings1.adf', tosecName: 'Lemmings (Disk 1).adf' },
          { id: 'd2', diskNo: 2, sourceFilename: null, tosecName: 'Lemmings (Disk 2).adf' },
        ],
      },
      { gameId: 'g2', title: 'Zool', disks: [{ id: 'd3', diskNo: 1, sourceFilename: 'Zool.adf', tosecName: null }] },
    ]);

    const diskSel = selects.find((s) => s.table === disks)!;
    const diskWhere = render(diskSel.where!);
    expect(diskWhere.sql).toMatch(/"disks"\."org_id" = \$\d+/);
    expect(diskWhere.params).toContain('org-1');
  });

  // The 2026-10-10 report: a 35-disk upload, all 35 titles sharing one
  // created_at. The dialog listed 20, said nothing about the other 14, the
  // operator ticked all 20 -- and 13 Workbench 3.2 disks stayed behind in
  // Uncategorized, looking as if Add disks had not filed them.
  it('says when titles exist beyond the page, and returns only the page', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `g${String(i).padStart(2, '0')}`, title: `T${i}` }));
    answer(games, rows);
    answer(disks, rows.map((r) => ({ gameId: r.id, id: `d-${r.id}`, diskNo: 1, tosecName: null, sourceFilename: null })));
    const result = await searchCandidates('org-1', '', 'G-self');
    expect(result.more).toBe(true);
    expect(result.titles.map((t) => t.gameId)).toEqual(rows.slice(0, 20).map((r) => r.id));
    // Only the page's titles have their disks read.
    expect(render(selects.find((s) => s.table === disks)!.where!).params).not.toContain('g20');
  });

  it('a page that holds everything says there is no more', async () => {
    answer(games, [{ id: 'g1', title: 'Lemmings' }]);
    answer(disks, [{ gameId: 'g1', id: 'd1', diskNo: 1, tosecName: null, sourceFilename: null }]);
    expect((await searchCandidates('org-1', '', null)).more).toBe(false);
  });

  it('a larger limit asks for that many (+1), clamped to 1..200', async () => {
    answer(games, [], [], []);
    await searchCandidates('org-1', '', null, 40);
    await searchCandidates('org-1', '', null, 100000);
    await searchCandidates('org-1', '', null, -5);
    expect(selects.filter((s) => s.table === games).map((s) => s.limit)).toEqual([41, 201, 2]);
  });

  it('returns nothing (and never queries disks) when no title matches', async () => {
    answer(games, []);
    const result = await searchCandidates('org-1', 'nope', null);
    expect(result).toEqual({ titles: [], more: false });
    expect(selects.some((s) => s.table === disks)).toBe(false);
  });
});
