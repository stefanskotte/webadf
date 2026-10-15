import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '@/db';

/**
 * Self-hosting P1 D4: record every migration in drizzle/ as applied, WITHOUT
 * running it, for a database whose schema already matches (production, built
 * by push + hand SQL before migrations were versioned). Writes exactly what
 * drizzle's migrator would: drizzle.__drizzle_migrations (hash, created_at),
 * with the table DDL copied from drizzle-orm 0.45's pg-core dialect.migrate().
 * Dry run unless { apply: true } / --apply. Refuses if a journal exists.
 */
export async function baseline({ apply }: { apply: boolean }): Promise<{ rows: { hash: string; createdAt: number }[] }> {
  const files = readMigrationFiles({ migrationsFolder: 'drizzle' });
  const rows = files.map((m) => ({ hash: m.hash, createdAt: m.folderMillis }));
  const db = getDb();
  const exists = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as e`);
  if (exists.rows[0].e) throw new Error('journal already exists -- nothing to baseline');
  if (!apply) return { rows };
  await db.transaction(async (tx) => {
    await tx.execute(sql`create schema if not exists drizzle`);
    await tx.execute(sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
    for (const r of rows) {
      await tx.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${r.hash}, ${r.createdAt})`);
    }
  });
  return { rows };
}

if (process.argv[1]?.endsWith('db-baseline.ts')) {
  const apply = process.argv.includes('--apply');
  baseline({ apply })
    .then(({ rows }) => { console.log(`${apply ? 'WROTE' : 'would write'} ${rows.length} rows; last created_at ${rows.at(-1)?.createdAt}`); })
    .catch((e) => { console.error('db:baseline:', e.message); process.exitCode = 1; })
    .finally(() => closeDb());
}
