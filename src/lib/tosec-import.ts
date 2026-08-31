import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { tosecEntries } from '@/db/schema/tosec';
import { parseDat } from '@/lib/tosec-dat';
import { stableId } from '@/lib/ingest';
import { chunk } from '@/lib/chunk';

/** Rows per INSERT, matching ingest/complete's INSERT_CHUNK reasoning. */
const INSERT_CHUNK = 250;

/** drizzle has no `excluded` shorthand; this names the conflicting row's column. */
const sqlExcluded = (col: string) => sql.raw(`excluded."${col}"`);

/**
 * Load a DAT into tosec_entries. Idempotent: ids are derived from
 * (setName, romName), so re-importing the same set updates rows in place
 * rather than duplicating them, and importing a NEWER release of the same
 * set corrects the entries it changed.
 *
 * Entries removed by a newer set are deliberately left behind rather than
 * deleted -- a blob matched to one would otherwise silently become
 * unmatched, and there is no foreign key forcing the issue.
 */
export async function importDat(text: string) {
  const dat = parseDat(text);
  const db = getDb();

  const rows = dat.entries.map((e) => ({
    id: stableId('tosec', dat.setName, e.romName),
    setName: dat.setName,
    setVersion: dat.setVersion,
    gameName: e.gameName,
    romName: e.romName,
    sizeBytes: e.sizeBytes,
    crc32: e.crc32, md5: e.md5, sha1: e.sha1,
    title: e.title, sortTitle: e.sortTitle, year: e.year,
    publisher: e.publisher, diskNo: e.diskNo, diskCount: e.diskCount,
  }));

  for (const part of chunk(rows, INSERT_CHUNK)) {
    await db.insert(tosecEntries).values(part).onConflictDoUpdate({
      target: tosecEntries.id,
      set: {
        setVersion: sqlExcluded('set_version'), gameName: sqlExcluded('game_name'),
        sizeBytes: sqlExcluded('size_bytes'), crc32: sqlExcluded('crc32'),
        md5: sqlExcluded('md5'), sha1: sqlExcluded('sha1'),
        title: sqlExcluded('title'), sortTitle: sqlExcluded('sort_title'),
        year: sqlExcluded('year'), publisher: sqlExcluded('publisher'),
        diskNo: sqlExcluded('disk_no'), diskCount: sqlExcluded('disk_count'),
      },
    });
  }

  return { setName: dat.setName, setVersion: dat.setVersion, imported: rows.length };
}
