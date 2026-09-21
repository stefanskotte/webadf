import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as catalog from './schema/catalog';
import * as authModule from './schema/auth';
import * as devices from './schema/devices';
import * as tosec from './schema/tosec';
import * as openretro from './schema/openretro';
import * as collections from './schema/collections';
import * as demozoo from './schema/demozoo';
import * as diskHistory from './schema/disk-history';
import * as firmware from './schema/firmware';

// `authSchema` (the `pgSchema('auth')` object itself) isn't a table — drop it
// so drizzle's schema map only contains the actual tables/relations.
const { authSchema: _authPgSchema, ...authTables } = authModule;
void _authPgSchema;

const schema = {
  ...catalog, ...authTables, ...devices, ...tosec, ...openretro, ...collections, ...demozoo, ...diskHistory, ...firmware,
};
let _db: NeonHttpDatabase<typeof schema> | null = null;

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}
