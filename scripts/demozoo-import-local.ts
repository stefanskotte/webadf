// Timing gate (spec §3.2) and the first real import, from a LOCAL export file.
//   npx dotenv -e .env.local -- npx tsx scripts/demozoo-import-local.ts /path/to/demozoo-export.sql.gz
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import { demozooImport } from '../src/db/schema/demozoo';
import { extractFromStream, writeExtract, IMPORT_ROW_ID } from '../src/lib/demozoo/import';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: demozoo-import-local.ts <export.sql.gz>');
  const db = getDb();

  let t = Date.now();
  const extract = await extractFromStream(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>);
  const extractMs = Date.now() - t;
  const rssMb = Math.round(process.memoryUsage().rss / 1e6);
  console.log(`EXTRACT ${extractMs} ms, ${extract.productions.length} productions, ${extract.screenshots.length} screenshots, rss ${rssMb} MB`);

  const runStartedAt = new Date();
  await db.insert(demozooImport).values({ id: IMPORT_ROW_ID, step: 'extracted', runStartedAt, lastAttemptAt: runStartedAt })
    .onConflictDoUpdate({ target: demozooImport.id, set: { step: 'extracted', runStartedAt, productionsWritten: 0, screenshotsWritten: 0 } });
  const cursor = (await db.select().from(demozooImport).where(eq(demozooImport.id, IMPORT_ROW_ID)))[0];

  t = Date.now();
  const result = await writeExtract(extract, cursor, () => false);
  const writeMs = Date.now() - t;
  await db.update(demozooImport).set({ step: 'applied', appliedAt: new Date() }).where(eq(demozooImport.id, IMPORT_ROW_ID));
  console.log(`WRITE ${writeMs} ms (${result})`);
  process.exit(0);
}
main();
