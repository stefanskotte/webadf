import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { getDb, closeDb } = await import('./index');
const { atomic } = await import('./atomic');

describe('atomic (node-postgres)', () => {
  beforeAll(async () => {
    await getDb().execute(sql`create table if not exists atomic_probe (id int primary key, v text)`);
    await getDb().execute(sql`truncate atomic_probe`);
  });
  afterAll(async () => {
    await getDb().execute(sql`drop table if exists atomic_probe`);
    await closeDb();
  });

  it('runs every statement and returns each result in order', async () => {
    const out = await atomic((tx) => [
      tx.execute(sql`insert into atomic_probe values (1, 'a') returning id`),
      tx.execute(sql`insert into atomic_probe values (2, 'b') returning id`),
    ]);
    expect(out).toHaveLength(2);
    const { rows } = await getDb().execute(sql`select count(*)::int as n from atomic_probe`);
    expect(rows[0].n).toBe(2);
  });

  it('rolls everything back when a later statement fails, and the unique violation is still recognisable', async () => {
    const err = await atomic((tx) => [
      tx.execute(sql`insert into atomic_probe values (3, 'c')`),
      tx.execute(sql`insert into atomic_probe values (1, 'dup')`),
    ]).catch((e) => e);
    const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe('23505');
    const { rows } = await getDb().execute(sql`select count(*)::int as n from atomic_probe where id = 3`);
    expect(rows[0].n).toBe(0);
  });
});
