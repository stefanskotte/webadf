import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, closeDb } from '@/db';

/** Applies drizzle/ to DATABASE_URL. The container runs this on start (P2); ours runs it by hand. */
async function main() {
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  console.log('db:migrate: up to date');
}
main().then(() => closeDb()).catch(async (e) => { console.error('db:migrate FAILED:', e); await closeDb(); process.exit(1); });
