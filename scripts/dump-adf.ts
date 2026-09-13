import { like, eq } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { getDb } from '../src/db';
import { disks, games } from '../src/db/schema/catalog';
import { diskStore } from '../src/lib/storage';
const rows = await getDb().select({ sha: disks.sha256, g: games.title })
  .from(disks).leftJoin(games, eq(games.id, disks.gameId))
  .where(like(disks.sha256, `${process.argv[2]}%`));
if (!rows.length) { console.log('no match'); process.exit(1); }
const adf = await diskStore.read(rows[0].sha);
writeFileSync(process.argv[3], adf);
console.log(`${rows[0].g}: wrote ${adf.length} bytes to ${process.argv[3]}`);
process.exit(0);
