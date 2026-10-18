import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { attachDatabasePool } from '@vercel/functions';
import * as catalog from './schema/catalog';
import * as authModule from './schema/auth';
import * as devices from './schema/devices';
import * as tosec from './schema/tosec';
import * as openretro from './schema/openretro';
import * as collections from './schema/collections';
import * as demozoo from './schema/demozoo';
import * as diskHistory from './schema/disk-history';
import * as firmware from './schema/firmware';
import * as stepUp from './schema/step-up';
import * as transfers from './schema/transfers';
import * as userPrefs from './schema/user-prefs';

// `authSchema` (the `pgSchema('auth')` object itself) isn't a table — drop it
// so drizzle's schema map only contains the actual tables/relations.
const { authSchema: _authPgSchema, ...authTables } = authModule;
void _authPgSchema;

const schema = {
  ...catalog, ...authTables, ...devices, ...tosec, ...openretro, ...collections, ...demozoo, ...diskHistory, ...firmware, ...stepUp, ...transfers, ...userPrefs,
};
export type Db = NodePgDatabase<typeof schema>;

let _pool: Pool | null = null;
let _db: Db | null = null;

/**
 * One driver for every deployment (self-hosting P1, D1): node-postgres over a
 * small pool. Ours points at Neon's POOLED endpoint, which does the real
 * pooling, hence max 5; a self-host points at its own Postgres. On Vercel the
 * pool is attached so idle clients close before an instance suspends (off
 * Vercel attachDatabasePool is inert: it returns early without VERCEL_URL).
 */
export function getDb(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
    // An idle client's error (Neon recycling it, a Postgres restart) comes back
    // as the pool's 'error' event; unheard, Node throws it and the whole
    // instance dies. The pool has already dropped that client.
    _pool.on('error', (err) => console.error('db: idle client error', err));
    attachDatabasePool(_pool);
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

/** Scripts and db tests only: lets the process exit. */
export async function closeDb(): Promise<void> {
  await _pool?.end();
  _pool = null;
  _db = null;
}
