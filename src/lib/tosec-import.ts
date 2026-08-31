import { sql, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { tosecEntries } from '@/db/schema/tosec';
import { blobs } from '@/db/schema/catalog';
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

  // Deduped by id (setName, romName): a real TOSEC set can genuinely
  // contain duplicate rom names -- e.g. "Commodore Amiga - Games - SPS"
  // has 672 duplicated rom names across 6,016 entries -- and two entries
  // in the same INSERT_CHUNK sharing an id makes Postgres raise "ON
  // CONFLICT DO UPDATE command cannot affect row a second time", aborting
  // the whole statement. Last-one-wins, via the Map's overwrite-on-same-key
  // semantics: within one DAT, two entries sharing (setName, romName) are
  // the same catalogued file, and the later definition is the one the file
  // ends on. Mirrors ingest/complete's blobRows/entitlementRows dedupe.
  const rows = [...new Map(dat.entries.map((e) => {
    const id = stableId('tosec', dat.setName, e.romName);
    return [id, {
      id,
      setName: dat.setName,
      setVersion: dat.setVersion,
      gameName: e.gameName,
      romName: e.romName,
      sizeBytes: e.sizeBytes,
      crc32: e.crc32, md5: e.md5, sha1: e.sha1,
      title: e.title, sortTitle: e.sortTitle, year: e.year,
      publisher: e.publisher, diskNo: e.diskNo, diskCount: e.diskCount,
    }];
  })).values()];

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

  // A newly imported or updated set invalidates every verdict reached without
  // it: sweep()'s phase-2 cursor is `match_checked_at IS NULL`, so a blob is
  // only ever considered once. Without this reset, importing a DAT after a
  // sweep matches nothing at all -- the blobs have already been "decided".
  //
  // Hashes are deliberately NOT cleared. Hashing is the expensive half (a full
  // read of every blob's bytes out of the object store) and a content hash
  // never changes, so re-matching is cheap while re-hashing would not be.
  await db.update(blobs).set({
    matchCheckedAt: null,
    matchState: null,
    tosecEntryId: null,
  }).where(isNotNull(blobs.matchCheckedAt));

  return { setName: dat.setName, setVersion: dat.setVersion, imported: rows.length };
}
