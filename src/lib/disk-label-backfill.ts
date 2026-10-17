/**
 * One-off backfill (field report 2026-10-17): fill an empty disks.label with
 * the disk's AmigaDOS volume name, for disks of multi-disk titles -- the ones
 * whose board line reads "Disk n/c <label>". New uploads and new sets store
 * the name themselves (ingest-complete.ts, disk-set-store.ts); this covers
 * the rows made before that.
 *
 * Idempotent: only a null or blank label is ever selected, and every UPDATE
 * repeats that condition, so a label a person or extract set -- even one set
 * while this runs -- is never overwritten, and a second run finds nothing it
 * has not already done (a disk with no readable name stays a candidate, and
 * stays untouched). Dry run unless `apply`. Reports counts only: no titles,
 * names, ids or credentials. Storage goes through diskStore, so a self-hosted
 * install (local disk store) runs it exactly like ours.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskStore } from '@/lib/storage';
import { mapLimit } from '@/lib/pool';
import { volumeNameOf } from '@/lib/disk-label';

export interface BackfillCounts {
  /** Disks of multi-disk titles with no label. */
  candidates: number;
  /** Of those, how many have a volume name (written, or that would be). */
  named: number;
  /** No DOS filesystem, or a blank volume name: left as they are. */
  noName: number;
  /** The store could not return the bytes: left as they are. */
  unreadable: number;
  /** Rows actually updated (0 on a dry run). */
  written: number;
}

const PAGE = 200;
const READ_CONCURRENCY = 4;

const labelIsEmpty = () => or(isNull(disks.label), sql`btrim(${disks.label}) = ${''}`);

export async function backfillDiskLabels({ apply }: { apply: boolean }): Promise<BackfillCounts> {
  const db = getDb();
  const counts: BackfillCounts = { candidates: 0, named: 0, noName: 0, unreadable: 0, written: 0 };
  let after = '';
  for (;;) {
    // Keyset-paged on the primary key, so a page written meanwhile cannot
    // shift what the next page reads.
    const page = await db.select({ id: disks.id, orgId: disks.orgId, sha256: disks.sha256 }).from(disks)
      .where(and(
        gt(disks.id, after),
        eq(disks.imageFormat, 'adf'),
        labelIsEmpty(),
        // Same count mount.ts sends as diskCount: this title's disks in this org.
        sql`(select count(*) from disks d2 where d2.game_id = ${disks.gameId} and d2.org_id = ${disks.orgId}) > 1`,
      ))
      .orderBy(disks.id)
      .limit(PAGE);
    if (page.length === 0) break;
    after = page[page.length - 1].id;
    counts.candidates += page.length;

    const names = await mapLimit(page, READ_CONCURRENCY, async (d) => {
      try {
        return volumeNameOf(await diskStore.read(d.sha256)) ?? ('none' as const);
      } catch {
        return 'unreadable' as const;
      }
    });
    for (let i = 0; i < page.length; i++) {
      const n = names[i];
      if (n === 'unreadable') { counts.unreadable++; continue; }
      if (n === 'none') { counts.noName++; continue; }
      counts.named++;
      if (!apply) continue;
      const done = await db.update(disks).set({ label: n })
        .where(and(eq(disks.id, page[i].id), eq(disks.orgId, page[i].orgId), labelIsEmpty()))
        .returning({ id: disks.id });
      counts.written += done.length;
    }
    if (page.length < PAGE) break;
  }
  return counts;
}
