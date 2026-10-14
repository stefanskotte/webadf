// deleteDisk against a fake db in the style of disk-set-store.test.ts: reads
// answer from a per-table queue in the order the function issues them; every
// write is a REAL drizzle builder on a pg-proxy db, so the delete, the batch
// and each UPDATE are recorded as the SQL Postgres would run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle as proxyDrizzle } from 'drizzle-orm/pg-proxy';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions } from '@/db/schema/disk-history';

let byTable: Map<unknown, unknown[][]>;
/** Statements run on their own (awaited directly), in order. */
let executed: { sql: string; params: unknown[] }[];
let batches: { sql: string; params: unknown[] }[][];

const proxy = proxyDrizzle(async (sql, params) => {
  executed.push({ sql, params });
  // The guarded games delete returns the row it removed.
  return { rows: /^delete from "games"/.test(sql) ? [[params[0]]] : [] };
});
const fakeDb = {
  select: () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => { table = t; return chain; },
      where: () => chain,
      limit: () => chain,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(byTable.get(table)?.shift() ?? []).then(res, rej),
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
const clearDesired = vi.fn(async () => undefined);
vi.mock('@/lib/mount', () => ({ clearDesired: (...a: unknown[]) => clearDesired(...(a as [])) }));
vi.mock('@/lib/storage', () => ({ diskStore: { read: vi.fn() } }));
vi.mock('@/lib/adffs', () => ({ readVolume: vi.fn() }));

const { deleteDisk } = await import('./disk-delete');

function answer(t: unknown, ...rows: unknown[][]) { byTable.set(t, rows); }

beforeEach(() => {
  byTable = new Map(); executed = []; batches = []; clearDesired.mockClear();
});

/** Title G holds a (1), b (2), c (3); b is deleted. */
function scenario(order: 'human' | null, devs: unknown[] = []) {
  answer(disks,
    [{ id: 'b', sha256: 'sha-b', gameId: 'G' }],                                  // the disk
    [{ id: 'c', gameId: 'G', diskNo: 3 }, { id: 'a', gameId: 'G', diskNo: 1 }],   // its siblings
    [{ id: 'a' }, { id: 'c' }],                                                   // remaining after
    [],                                                                           // entitlement check
  );
  answer(games, [{ diskOrderSource: order }]);
  answer(devices, [], [], devs);   // eject by id, eject by sha, then the org's devices
  answer(diskVersions, []);
  answer(entitlements, []);
}

describe('deleteDisk: a middle disk of a human-arranged set (m1)', () => {
  it('deletes it and renumbers the rest 1..N in their order, in ONE batch', async () => {
    scenario('human');
    await deleteDisk('org-1', 'b');
    expect(batches).toHaveLength(1);
    const [b] = batches;
    expect(b[0].sql).toMatch(/^delete from "disks"/);
    expect(b[0].params).toEqual(['b', 'org-1']);
    // Pinned to G, like every renumber in disk-set-store.
    expect(b.filter((s) => /^update "disks"/.test(s.sql)).map((s) => s.params)).toEqual([
      ['G', 1, 'a', 'org-1', 'G'], ['G', 2, 'c', 'org-1', 'G'],
    ]);
    // Not deleted on its own as well.
    expect(executed.some((s) => /^delete from "disks"/.test(s.sql))).toBe(false);
    expect(executed.some((s) => /^delete from "games"/.test(s.sql))).toBe(false);
  });

  it('moves a board holding a renumbered disk to its new number, guarded, never its disk id or version', async () => {
    scenario('human', [{ id: 'dev', desiredDiskId: 'c', mountedDiskId: 'c' }]);
    await deleteDisk('org-1', 'b');
    const dev = batches[0].filter((s) => /^update "devices"/.test(s.sql));
    expect(dev).toHaveLength(2);
    expect(dev[0].sql).toMatch(/^update "devices" set "desired_game_id" = \$1, "desired_disk_no" = \$2 where/);
    expect(dev[0].sql).toMatch(/"devices"\."desired_disk_id" = \$\d+/);
    // The last three: the EXISTS guard -- disk c really is at G, number 2.
    expect(dev[0].params).toEqual(['G', 2, 'dev', 'org-1', 'c', 'c', 'G', 2]);
    expect(dev[0].sql).toMatch(/exists \(select 1 from "disks" "d" where "d"\."id" = \$6 and "d"\."game_id" = \$7 and "d"\."disk_no" = \$8\)/);
    expect(dev[1].sql).toMatch(/^update "devices" set "mounted_game_id" = \$1, "mounted_disk_no" = \$2 where/);
    expect(dev[1].params).toEqual(['G', 2, 'dev', 'org-1', 'c', 'c', 'G', 2]);
    expect(dev[1].sql).toMatch(/exists \(select 1 from "disks" "d" where "d"\."id" = \$6/);
    for (const s of dev) expect(s.sql.slice(0, s.sql.indexOf(' where ')))
      .not.toMatch(/"desired_disk_id"|"mounted_disk_id"|"desired_version"/);
  });

  it('a set that is not human-arranged keeps its numbers (a plain delete, no batch)', async () => {
    scenario(null);
    await deleteDisk('org-1', 'b');
    expect(batches).toHaveLength(0);
    expect(executed.filter((s) => /^delete from "disks"/.test(s.sql))).toHaveLength(1);
    expect(executed.some((s) => /^update "disks"/.test(s.sql))).toBe(false);
  });

  it('no gap (the last disk went) means no renumbering', async () => {
    answer(disks,
      [{ id: 'c', sha256: 'sha-c', gameId: 'G' }],
      [{ id: 'a', gameId: 'G', diskNo: 1 }, { id: 'b', gameId: 'G', diskNo: 2 }],
      [{ id: 'a' }, { id: 'b' }], []);
    answer(games, [{ diskOrderSource: 'human' }]);
    answer(devices, [], []);
    await deleteDisk('org-1', 'c');
    expect(batches).toHaveLength(0);
    expect(executed.some((s) => /^update "disks"/.test(s.sql))).toBe(false);
  });
});

describe('deleteDisk: a disk in DF1', () => {
  it('a deleted disk mounted into DF1 leaves it, with the cursor moved (spec 2026-10-14 §3.2, Review Focus 5)', async () => {
    scenario(null);
    await deleteDisk('org-1', 'b');
    // drizzle renders a null SET either as a parameter or as a literal: both are accepted.
    const df1 = executed.find((e) => /^update "devices" set "df1_disk_id" = (\$\d+|null), "df1_version" = /.test(e.sql));
    expect(df1, executed.map((e) => e.sql).join('\n')).toBeDefined();
    expect(df1!.sql).toMatch(/"df1_disk_id" in \(\$\d+\)/);
    expect(df1!.params).toEqual(expect.arrayContaining(['org-1', 'b']));
    // ...before the disk row goes (the FK's SET NULL would tell no board).
    const del = executed.findIndex((e) => /^delete from "disks"/.test(e.sql));
    expect(executed.indexOf(df1!)).toBeLessThan(del === -1 ? Infinity : del);
  });
});

describe('deleteDisk: the last disk of a title', () => {
  it('deletes the title, guarded so a title still holding ANY disk survives', async () => {
    answer(disks, [{ id: 'a', sha256: 'sha-a', gameId: 'G' }], [], [], []);
    answer(games, [{ diskOrderSource: 'human' }]);
    answer(devices, [], []);
    const r = await deleteDisk('org-1', 'a');
    const del = executed.find((s) => /^delete from "games"/.test(s.sql))!;
    expect(del.sql).toMatch(/not exists \(select 1 from "disks" "d" where "d"\."game_id" = "games"\."id"\)/);
    expect(del.params).toEqual(expect.arrayContaining(['G', 'org-1']));
    expect(r?.gameDeleted).toBe(true);
    expect(batches).toHaveLength(0);
  });
});
