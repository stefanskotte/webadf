import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle as proxyDrizzle } from 'drizzle-orm/pg-proxy';
import type { SQL } from 'drizzle-orm';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { collectionGames } from '@/db/schema/collections';

// Fake db in the style of mount-record-status.test.ts, extended for reads and
// a batch. Reads: each select answers from a per-table queue, in the order the
// store issues them, and its WHERE (and JOIN ON) is kept so org scoping can be
// asserted on the rendered SQL. Writes: update/insert/delete are REAL drizzle
// builders (a pg-proxy db that is never executed), so the batch is recorded as
// the exact SQL Postgres would run -- statement order, predicates and SET
// columns are all visible. What this harness cannot do is execute that SQL:
// "a title that still has a disk is not deleted" is proven on the statement's
// shape (the NOT EXISTS guard), not by running it.

type Sel = { table: unknown; where: SQL | undefined; joins: SQL[] };
let byTable: Map<unknown, unknown[][]>;
let selects: Sel[];
let batches: { sql: string; params: unknown[] }[][];

const proxy = proxyDrizzle(async () => ({ rows: [] }));
const fakeDb = {
  select: () => {
    const q: Sel = { table: undefined, where: undefined, joins: [] };
    const chain = {
      from: (t: unknown) => { q.table = t; return chain; },
      innerJoin: (_t: unknown, on: SQL) => { q.joins.push(on); return chain; },
      where: (w: SQL) => { q.where = w; return chain; },
      orderBy: () => chain,
      limit: () => chain,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        selects.push(q);
        return Promise.resolve(byTable.get(q.table)?.shift() ?? []).then(res, rej);
      },
    };
    return chain;
  },
  update: proxy.update.bind(proxy),
  insert: proxy.insert.bind(proxy),
  delete: proxy.delete.bind(proxy),
  batch: async (items: { toSQL: () => { sql: string; params: unknown[] } }[]) => {
    batches.push(items.map((i) => i.toSQL()));
    return [];
  },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));


const { addDisksToSet, reorderSet, moveDiskOut, undoMove, NotFound } = await import('./disk-set-store');
const { PlanError } = await import('./disk-set');

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);

function answer(t: unknown, ...rows: unknown[][]) { byTable.set(t, rows); }
const only = () => { expect(batches).toHaveLength(1); return batches[0]; };
const idx = (b: { sql: string }[], re: RegExp) => b.findIndex((s) => re.test(s.sql));

beforeEach(() => {
  byTable = new Map(); selects = []; batches = [];
});

const game = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `T ${id}`, year: 1990, publisher: 'Psygnosis', metadataSource: 'tosec', diskOrderSource: null,
  coverAssetId: null, coverOverrideSha256: null, demozooProductionId: null, ...over,
});

/** Target G with d1; picked: s2 of title S (S also holds s1, unpicked). */
function addScenario(opts: { collection?: boolean } = {}) {
  answer(games, [{ id: 'G' }], [game('S')]);
  answer(disks,
    [{ id: 'd1', gameId: 'G', diskNo: 1 }],                                          // target's disks
    [{ id: 's2', gameId: 'S', diskNo: 2 }],                                          // picked
    [{ id: 's1', gameId: 'S', diskNo: 1 }, { id: 's2', gameId: 'S', diskNo: 2 }],     // ALL of S
  );
  answer(collectionGames, opts.collection ? [{ gameId: 'S' }] : []);
  answer(devices, [
    { id: 'dev-m', desiredDiskId: null, mountedDiskId: 's1' },
    { id: 'dev-x', desiredDiskId: 'd1', mountedDiskId: 'd1' },
  ]);
}

describe('addDisksToSet', () => {
  it('moves EVERY disk of a picked source title, not just the picked one', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    const b = only();
    const moves = b.filter((s) => /^update "disks"/.test(s.sql));
    expect(moves.map((m) => m.params)).toEqual([
      ['G', 2, 's1', 'org-1', 'S'],
      ['G', 3, 's2', 'org-1', 'S'],
    ]);
  });

  it('appends the picked titles in the order the caller sent, not the order the read returned', async () => {
    answer(games, [{ id: 'G' }], [game('P'), game('Q')]);
    answer(disks,
      [{ id: 'd1', gameId: 'G', diskNo: 1 }],
      // The IN (...) read answers Q's disk first; the caller asked for P then Q.
      [{ id: 'q1', gameId: 'Q', diskNo: 1 }, { id: 'p1', gameId: 'P', diskNo: 1 }],
      [{ id: 'q1', gameId: 'Q', diskNo: 1 }, { id: 'p1', gameId: 'P', diskNo: 1 }],
    );
    answer(collectionGames, []);
    answer(devices, []);
    await addDisksToSet('org-1', 'G', ['p1', 'q1']);
    const moves = only().filter((s) => /^update "disks"/.test(s.sql));
    expect(moves.map((m) => m.params)).toEqual([
      ['G', 2, 'p1', 'org-1', 'P'],
      ['G', 3, 'q1', 'org-1', 'Q'],
    ]);
  });

  it('pins every disk UPDATE to the title it was read in (m4)', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    for (const m of only().filter((s) => /^update "disks"/.test(s.sql))) {
      expect(m.sql).toMatch(/where \("disks"\."id" = \$\d+ and "disks"\."org_id" = \$\d+ and "disks"\."game_id" = \$\d+\)/);
    }
  });

  it('a rename (the suggestion path) renumbers the target\'s own disks from 1 too (m2)', async () => {
    answer(games, [{ id: 'G' }], [game('S')]);
    answer(disks,
      [{ id: 'd2', gameId: 'G', diskNo: 2 }],           // a lone target TOSEC numbered "Disk 2"
      [{ id: 's1', gameId: 'S', diskNo: 1 }],
      [{ id: 's1', gameId: 'S', diskNo: 1 }],
    );
    answer(collectionGames, []); answer(devices, []);
    await addDisksToSet('org-1', 'G', ['s1'], 'My Set');
    expect(only().filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params)).toEqual([
      ['G', 1, 'd2', 'org-1', 'G'],
      ['G', 2, 's1', 'org-1', 'S'],
    ]);
  });

  it('updates a device whose mountedDiskId is a moved disk (Review Focus 1), org- and id-scoped', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    const b = only();
    const dev = b.filter((s) => /^update "devices"/.test(s.sql));
    expect(dev).toHaveLength(1);
    expect(dev[0].sql).toMatch(/set "mounted_game_id" = \$1, "mounted_disk_no" = \$2/);
    expect(dev[0].sql).toMatch(/"devices"\."id" = \$\d+ and "devices"\."org_id" = \$\d+/);
    expect(dev[0].params).toEqual(expect.arrayContaining(['G', 2, 'dev-m', 'org-1', 's1']));
    // Never the disk-id columns or the version: nothing changes which disk a board holds.
    for (const s of dev) expect(s.sql.slice(0, s.sql.indexOf(' where ')))
      .not.toMatch(/"desired_disk_id"|"mounted_disk_id"|"desired_version"/);
  });

  it('each device UPDATE also requires the disk to sit at the planned title and number (desired and mounted)', async () => {
    addScenario();
    byTable.set(devices, [[{ id: 'dev-b', desiredDiskId: 's1', mountedDiskId: 's1' }]]);
    await addDisksToSet('org-1', 'G', ['s2']);
    const dev = only().filter((s) => /^update "devices"/.test(s.sql));
    expect(dev).toHaveLength(2);
    const guard = /exists \(select 1 from "disks" "d" where "d"\."id" = \$(\d+) and "d"\."game_id" = \$(\d+) and "d"\."disk_no" = \$(\d+)\)/;
    for (const [i, col] of [[0, 'desired'], [1, 'mounted']] as const) {
      expect(dev[i].sql).toMatch(new RegExp(`^update "devices" set "${col}_game_id"`));
      const m = dev[i].sql.match(guard)!;
      expect(m).not.toBeNull();
      const [id, g, n] = [m[1], m[2], m[3]].map((k) => dev[i].params[Number(k) - 1]);
      expect([id, g, n]).toEqual(['s1', 'G', 2]);
    }
  });

  it('batch order: disks, devices, target, collection_games, games; the games delete is guarded', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    const b = only();
    const iDisk = idx(b, /^update "disks"/);
    const iDev = idx(b, /^update "devices"/);
    const iTarget = idx(b, /^update "games" set "disk_order_source"/);
    const iCg = idx(b, /^delete from "collection_games"/);
    const iGames = idx(b, /^delete from "games"/);
    expect([iDisk, iDev, iTarget, iCg, iGames].every((i) => i >= 0)).toBe(true);
    expect(iDisk).toBeLessThan(iDev);
    expect(iDev).toBeLessThan(iTarget);
    expect(iTarget).toBeLessThan(iCg);
    expect(iCg).toBeLessThan(iGames);
    const del = b[iGames];
    expect(del.sql).toMatch(/"games"\."org_id" = \$\d+/);
    expect(del.params).toEqual(expect.arrayContaining(['S', 'org-1']));
    // Defence in depth (controller ruling 1): the delete cannot remove a title
    // that still has ANY disk -- the guard is deliberately not org-scoped.
    expect(del.sql).toMatch(/not exists \(select 1 from "disks" "d" where "d"\."game_id" = "games"\."id"\)/);
    // The collection memberships go only with a title that really is empty.
    expect(b[iCg].sql).toMatch(/not exists \(select 1 from "disks" "d" where "d"\."game_id" = "collection_games"\."game_id"\)/);
  });

  it('a title whose disks were not all loaded (drifted org) is guarded, not deleted blind', async () => {
    // S holds s1 (org-1) and a disk whose org_id drifted, so the org-scoped read
    // does not return it. The plan still calls S emptied; only the guard saves it.
    answer(games, [{ id: 'G' }], [game('S')]);
    answer(disks, [], [{ id: 's1', gameId: 'S', diskNo: 1 }], [{ id: 's1', gameId: 'S', diskNo: 1 }]);
    answer(collectionGames, []); answer(devices, []);
    await addDisksToSet('org-1', 'G', ['s1']);
    const del = only().find((s) => /^delete from "games"/.test(s.sql))!;
    expect(del.sql).toMatch(/not exists \(select 1 from "disks" "d" where "d"\."game_id" = "games"\."id"\)/);
  });

  it('marks the target human; a rename also sets title, sortTitle and metadataSource', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2'], 'The Secret of Monkey Island');
    const t = only().find((s) => /^update "games"/.test(s.sql))!;
    expect(t.sql).toMatch(/"disk_order_source" = \$\d+/);
    expect(t.sql).toMatch(/"title" = \$\d+, "sort_title" = \$\d+, "metadata_source" = \$\d+/);
    expect(t.params).toEqual(expect.arrayContaining(
      ['human', 'The Secret of Monkey Island', 'secret of monkey island, the', 'G', 'org-1']));
  });

  it('a rename equal to the current title writes neither title nor metadataSource, and still compacts', async () => {
    // A drop onto a TOSEC-identified title with the prefilled name untouched
    // must not freeze that title against later corrections.
    answer(games, [{ id: 'G', title: 'Lemmings' }], [game('S')]);
    answer(disks,
      [{ id: 'd2', gameId: 'G', diskNo: 2 }],
      [{ id: 's1', gameId: 'S', diskNo: 1 }],
      [{ id: 's1', gameId: 'S', diskNo: 1 }],
    );
    answer(collectionGames, []); answer(devices, []);
    await addDisksToSet('org-1', 'G', ['s1'], ' Lemmings ');
    const b = only();
    const t = b.find((s) => /^update "games"/.test(s.sql))!;
    expect(t.sql).toMatch(/^update "games" set "disk_order_source" = \$1 where/);
    expect(t.sql).not.toMatch(/"title"|"metadata_source"/);
    expect(b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params)).toEqual([
      ['G', 1, 'd2', 'org-1', 'G'],
      ['G', 2, 's1', 'org-1', 'S'],
    ]);
  });

  it('without a rename leaves the title alone', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    const t = only().find((s) => /^update "games"/.test(s.sql))!;
    expect(t.sql).not.toMatch(/"title"/);
  });

  it('returns an undo snapshot per emptied title, with hadExtras', async () => {
    addScenario({ collection: true });
    const { undo } = await addDisksToSet('org-1', 'G', ['s2']);
    expect(undo).toEqual([{
      diskIds: ['s1', 's2'], title: 'T S', year: 1990, publisher: 'Psygnosis',
      metadataSource: 'tosec', diskOrderSource: null, hadExtras: true,
    }]);
  });

  it('carries a human-arranged source title\'s disk_order_source in its undo snapshot (I4)', async () => {
    addScenario();
    byTable.set(games, [[{ id: 'G' }], [game('S', { diskOrderSource: 'human' })]]);
    const { undo } = await addDisksToSet('org-1', 'G', ['s2']);
    expect(undo[0].diskOrderSource).toBe('human');
  });

  it('hadExtras is true when the emptied title had its own cover image', async () => {
    addScenario();
    byTable.set(games, [[{ id: 'G' }], [game('S', { coverOverrideSha256: 'c'.repeat(64) })]]);
    const { undo } = await addDisksToSet('org-1', 'G', ['s2']);
    expect(undo[0].hadExtras).toBe(true);
  });

  it('hadExtras is false with no cover, no Demozoo link and no collection', async () => {
    addScenario();
    const { undo } = await addDisksToSet('org-1', 'G', ['s2']);
    expect(undo[0].hadExtras).toBe(false);
  });

  it('every read is org-scoped', async () => {
    addScenario();
    await addDisksToSet('org-1', 'G', ['s2']);
    expect(selects.length).toBeGreaterThanOrEqual(6);
    for (const q of selects) {
      const parts = [q.where, ...q.joins].filter(Boolean).map((w) => render(w as SQL));
      expect(parts.some((p) => /"org_id" = \$\d+/.test(p.sql) && p.params.includes('org-1'))).toBe(true);
    }
  });

  it('a missing target is NotFound, and nothing is written', async () => {
    answer(games, []);
    await expect(addDisksToSet('org-1', 'G', ['s2'])).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });

  it('a picked disk outside the org is NotFound, and nothing is written', async () => {
    answer(games, [{ id: 'G' }]);
    answer(disks, [], []);
    await expect(addDisksToSet('org-1', 'G', ['foreign'])).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });

  it('a source title outside the org is NotFound (never deleted from here)', async () => {
    answer(games, [{ id: 'G' }], []);
    answer(disks, [], [{ id: 's1', gameId: 'OTHER', diskNo: 1 }]);
    await expect(addDisksToSet('org-1', 'G', ['s1'])).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });

  it('a disk already in the target is PlanError same_title', async () => {
    answer(games, [{ id: 'G' }], []);
    answer(disks, [{ id: 'd1', gameId: 'G', diskNo: 1 }], [{ id: 'd1', gameId: 'G', diskNo: 1 }]);
    await expect(addDisksToSet('org-1', 'G', ['d1'])).rejects.toMatchObject({ code: 'same_title' });
    expect(batches).toHaveLength(0);
  });
});

describe('addDisksToSet by source titles (drag a card onto a card)', () => {
  /** Target G with d1; source titles P (p1, p2) and Q (q1), all org-1. */
  function titlesScenario() {
    answer(games,
      [{ id: 'G' }],                                  // requireGame
      [{ id: 'Q' }, { id: 'P' }],                     // the sources, org-scoped (any order)
      [game('P'), game('Q')],                         // the common path's source read
    );
    answer(disks,
      // every disk of the sources, in whatever order the database likes
      [{ id: 'q1', gameId: 'Q', diskNo: 1 }, { id: 'p2', gameId: 'P', diskNo: 2 }, { id: 'p1', gameId: 'P', diskNo: 1 }],
      [{ id: 'd1', gameId: 'G', diskNo: 1 }],         // target's disks
      [{ id: 'q1', gameId: 'Q', diskNo: 1 }, { id: 'p1', gameId: 'P', diskNo: 1 }, { id: 'p2', gameId: 'P', diskNo: 2 }],
      [{ id: 'q1', gameId: 'Q', diskNo: 1 }, { id: 'p1', gameId: 'P', diskNo: 1 }, { id: 'p2', gameId: 'P', diskNo: 2 }],
    );
    answer(collectionGames, []);
    answer(devices, []);
  }

  it('moves ALL disks of each source title, sources in the order sent, each in disk order', async () => {
    titlesScenario();
    await addDisksToSet('org-1', 'G', { sourceGameIds: ['P', 'Q'] }, 'My Set');
    const b = only();
    expect(b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params)).toEqual([
      ['G', 1, 'd1', 'org-1', 'G'],
      ['G', 2, 'p1', 'org-1', 'P'],
      ['G', 3, 'p2', 'org-1', 'P'],
      ['G', 4, 'q1', 'org-1', 'Q'],
    ]);
    // Same batch as the disk path: the target renamed, both sources deleted, guarded.
    const t = b.find((s) => /^update "games"/.test(s.sql))!;
    expect(t.params).toEqual(expect.arrayContaining(['human', 'My Set', 'G', 'org-1']));
    const del = b.find((s) => /^delete from "games"/.test(s.sql))!;
    expect(del.params).toEqual(expect.arrayContaining(['P', 'Q', 'org-1']));
    expect(del.sql).toMatch(/not exists \(select 1 from "disks" "d" where "d"\."game_id" = "games"\."id"\)/);
  });

  it('every read is org-scoped', async () => {
    titlesScenario();
    await addDisksToSet('org-1', 'G', { sourceGameIds: ['P', 'Q'] });
    for (const q of selects) {
      const parts = [q.where, ...q.joins].filter(Boolean).map((w) => render(w as SQL));
      expect(parts.some((p) => /"org_id" = \$\d+/.test(p.sql) && p.params.includes('org-1'))).toBe(true);
    }
  });

  it('a source title of another org is NotFound, and nothing is written', async () => {
    answer(games, [{ id: 'G' }], [{ id: 'P' }]);   // the org-scoped read does not return FOREIGN
    await expect(addDisksToSet('org-1', 'G', { sourceGameIds: ['P', 'FOREIGN'] })).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });

  it('the target itself as a source is same_title, and nothing is written', async () => {
    answer(games, [{ id: 'G' }]);
    await expect(addDisksToSet('org-1', 'G', { sourceGameIds: ['G'] })).rejects.toMatchObject({ code: 'same_title' });
    expect(batches).toHaveLength(0);
  });

  it('a source title with no disks is nothing_to_add, and nothing is written', async () => {
    answer(games, [{ id: 'G' }], [{ id: 'P' }, { id: 'E' }]);
    answer(disks, [{ id: 'p1', gameId: 'P', diskNo: 1 }]);
    await expect(addDisksToSet('org-1', 'G', { sourceGameIds: ['P', 'E'] })).rejects.toMatchObject({ code: 'nothing_to_add' });
    expect(batches).toHaveLength(0);
  });

  it('an unknown target is NotFound before any source is read', async () => {
    answer(games, []);
    await expect(addDisksToSet('org-1', 'G', { sourceGameIds: ['P'] })).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });

  it('an empty list is nothing_to_add', async () => {
    await expect(addDisksToSet('org-1', 'G', { sourceGameIds: [] })).rejects.toMatchObject({ code: 'nothing_to_add' });
  });
});

describe('reorderSet', () => {
  it('renumbers 1..N, updates devices, marks human; deletes nothing', async () => {
    answer(games, [{ id: 'G' }]);
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1 }, { id: 'b', gameId: 'G', diskNo: 2 }]);
    answer(devices, [{ id: 'dev', desiredDiskId: 'b', mountedDiskId: null }]);
    await reorderSet('org-1', 'G', ['b', 'a']);
    const b = only();
    expect(b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params))
      .toEqual([['G', 1, 'b', 'org-1', 'G'], ['G', 2, 'a', 'org-1', 'G']]);
    const dev = b.find((s) => /^update "devices"/.test(s.sql))!;
    expect(dev.sql).toMatch(/set "desired_game_id" = \$1, "desired_disk_no" = \$2/);
    expect(dev.params).toEqual(expect.arrayContaining(['G', 1, 'dev', 'org-1', 'b']));
    expect(idx(b, /^update "games" set "disk_order_source"/)).toBeGreaterThan(idx(b, /^update "devices"/));
    expect(idx(b, /^delete/)).toBe(-1);
  });

  it('a list that is not the current disks is stale_order, nothing written', async () => {
    answer(games, [{ id: 'G' }]);
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1 }, { id: 'b', gameId: 'G', diskNo: 2 }]);
    answer(devices, []);
    const err = await reorderSet('org-1', 'G', ['a']).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe('stale_order');
    expect(batches).toHaveLength(0);
  });

  it('a missing title is NotFound', async () => {
    answer(games, []);
    await expect(reorderSet('org-1', 'G', ['a'])).rejects.toBeInstanceOf(NotFound);
  });
});

describe('moveDiskOut', () => {
  function outScenario(remaining = [{ id: 'b', gameId: 'G', diskNo: 3 }], tosecName: string | null = null) {
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1, sha256: 'sha-a', tosecName }], remaining);
    answer(games, [{ id: 'G' }]);
    answer(entitlements, [{ sourceFilename: 'amiga-wb31_extras.adf' }]);
    answer(devices, [{ id: 'dev', desiredDiskId: 'b', mountedDiskId: 'a' }]);
  }

  it('names the new title after the file name without its extension and moves the disk there as disk 1', async () => {
    outScenario();
    const { gameId } = await moveDiskOut('org-1', 'a');
    const b = only();
    expect(b[0].sql).toMatch(/^insert into "games"/);
    expect(b[0].params).toEqual(expect.arrayContaining([gameId, 'org-1', 'amiga-wb31_extras', 'human']));
    const moves = b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params);
    expect(moves).toEqual([[gameId, 1, 'a', 'org-1', 'G'], ['G', 1, 'b', 'org-1', 'G']]);
    const dev = b.filter((s) => /^update "devices"/.test(s.sql));
    expect(dev.map((d) => d.params)).toEqual(expect.arrayContaining([
      expect.arrayContaining(['G', 1, 'dev', 'org-1', 'b']),
      expect.arrayContaining([gameId, 1, 'dev', 'org-1', 'a']),
    ]));
    expect(b.some((s) => /^update "games" set "disk_order_source"/.test(s.sql) && s.params.includes('G'))).toBe(true);
    expect(idx(b, /^delete/)).toBe(-1);
  });

  it('strips only a disk image extension from the name', async () => {
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1, sha256: 'sha-a', tosecName: null }], [{ id: 'b', gameId: 'G', diskNo: 2 }]);
    answer(games, [{ id: 'G' }]);
    answer(entitlements, [{ sourceFilename: 'Game v1.2' }]);
    answer(devices, []);
    await moveDiskOut('org-1', 'a');
    expect(only()[0].params).toContain('Game v1.2');
  });

  it('the file name wins over the TOSEC name', async () => {
    outScenario(undefined, 'Workbench v3.1 (1993)(Commodore)(Disk 2 of 6)(Extras).adf');
    await moveDiskOut('org-1', 'a');
    expect(only()[0].params).toContain('amiga-wb31_extras');
  });

  it('falls back to the TOSEC name without its extension when there is no entitlement', async () => {
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1, sha256: 'sha-a', tosecName: 'Lemmings (1991)(Psygnosis)(Disk 2 of 2).adf' }],
      [{ id: 'b', gameId: 'G', diskNo: 2 }]);
    answer(games, [{ id: 'G' }]);
    answer(entitlements, []);
    answer(devices, []);
    await moveDiskOut('org-1', 'a');
    expect(only()[0].params).toContain('Lemmings (1991)(Psygnosis)(Disk 2 of 2)');
  });

  it('falls back to "Disk" with no entitlement and no TOSEC name', async () => {
    answer(disks, [{ id: 'a', gameId: 'G', diskNo: 1, sha256: 'sha-a', tosecName: null }], [{ id: 'b', gameId: 'G', diskNo: 2 }]);
    answer(games, [{ id: 'G' }]);
    answer(entitlements, []);
    answer(devices, []);
    await moveDiskOut('org-1', 'a');
    expect(only()[0].params).toContain('Disk');
  });

  it('refuses a lone disk (not_in_a_set) before reading its name, and writes nothing', async () => {
    outScenario([]);
    const err = await moveDiskOut('org-1', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe('not_in_a_set');
    expect(selects.some((q) => q.table === entitlements)).toBe(false);
    expect(batches).toHaveLength(0);
  });

  it('a disk outside the org is NotFound', async () => {
    answer(disks, []);
    await expect(moveDiskOut('org-1', 'a')).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });
});

describe('undoMove', () => {
  const snap = {
    diskIds: ['s1', 's2'], title: 'The Lemmings', year: 1991, publisher: 'Psygnosis',
    metadataSource: 'tosec', diskOrderSource: 'human' as const, hadExtras: false,
  };

  it('recreates the title and moves the disks back 1..N; the set left behind is renumbered', async () => {
    answer(disks,
      [{ id: 's2', gameId: 'G', diskNo: 3 }, { id: 's1', gameId: 'G', diskNo: 2 }],
      [{ id: 'd1', gameId: 'G', diskNo: 1 }, { id: 's1', gameId: 'G', diskNo: 2 }, { id: 's2', gameId: 'G', diskNo: 3 }, { id: 'd4', gameId: 'G', diskNo: 4 }],
    );
    answer(games, [{ id: 'G' }]);
    answer(devices, [{ id: 'dev', desiredDiskId: 'd4', mountedDiskId: 's2' }]);
    const { gameId } = await undoMove('org-1', snap);
    const b = only();
    expect(b[0].sql).toMatch(/^insert into "games"/);
    // sortTitle derived on the server from the title; disk_order_source restored (I4).
    expect(b[0].sql).toMatch(/"disk_order_source"/);
    expect(b[0].params).toEqual(expect.arrayContaining(
      [gameId, 'org-1', 'The Lemmings', 'lemmings, the', 1991, 'Psygnosis', 'tosec', 'human']));
    // Each move pinned to G, where the disks sit now (m4).
    expect(b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params)).toEqual([
      [gameId, 1, 's1', 'org-1', 'G'], [gameId, 2, 's2', 'org-1', 'G'],
      ['G', 1, 'd1', 'org-1', 'G'], ['G', 2, 'd4', 'org-1', 'G'],
    ]);
    const dev = b.filter((s) => /^update "devices"/.test(s.sql)).map((s) => s.params);
    expect(dev).toEqual(expect.arrayContaining([
      expect.arrayContaining([gameId, 2, 'dev', 'org-1', 's2']),
      expect.arrayContaining(['G', 2, 'dev', 'org-1', 'd4']),
    ]));
    expect(idx(b, /^delete/)).toBe(-1);
  });

  it('stale_undo when undoing would leave a title with no disks; nothing written', async () => {
    answer(disks, [{ id: 's1', gameId: 'G', diskNo: 1 }, { id: 's2', gameId: 'G', diskNo: 2 }],
      [{ id: 's1', gameId: 'G', diskNo: 1 }, { id: 's2', gameId: 'G', diskNo: 2 }]);
    answer(games, [{ id: 'G' }]);
    answer(devices, []);
    const err = await undoMove('org-1', snap).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe('stale_undo');
    expect(batches).toHaveLength(0);
  });

  it('stale_undo when the snapshot disks are no longer in one title; nothing written', async () => {
    answer(disks, [{ id: 's1', gameId: 'G', diskNo: 2 }, { id: 's2', gameId: 'H', diskNo: 2 }],
      [{ id: 'd1', gameId: 'G', diskNo: 1 }, { id: 's1', gameId: 'G', diskNo: 2 },
        { id: 'h1', gameId: 'H', diskNo: 1 }, { id: 's2', gameId: 'H', diskNo: 2 }]);
    answer(games, [{ id: 'G' }, { id: 'H' }]);
    answer(devices, []);
    const err = await undoMove('org-1', snap).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.code).toBe('stale_undo');
    expect(batches).toHaveLength(0);
  });

  it('a snapshot disk no longer in the org is NotFound, nothing written', async () => {
    answer(disks, [{ id: 's1', gameId: 'G', diskNo: 1 }]);
    await expect(undoMove('org-1', snap)).rejects.toBeInstanceOf(NotFound);
    expect(batches).toHaveLength(0);
  });
});
