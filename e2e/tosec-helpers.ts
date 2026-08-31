import { getDb } from '@/db';
import { tosecEntries } from '@/db/schema/tosec';
import { eq } from 'drizzle-orm';
import { stableId } from '@/lib/ingest';

const seededIds: string[] = [];

/** Seed one TOSEC entry directly. Avoids needing a real DAT file in the suite. */
export async function seedTosecEntry(opts: {
  setName?: string; gameName: string; romName: string;
  sizeBytes?: number; sha1?: string | null; md5?: string | null; crc32?: string | null;
  title: string; sortTitle: string; year?: number | null; publisher?: string | null;
  diskNo?: number | null; diskCount?: number | null;
}) {
  const setName = opts.setName ?? 'e2e-set';
  const id = stableId('tosec', setName, opts.romName);
  await getDb().insert(tosecEntries).values({
    id, setName, setVersion: 'e2e',
    gameName: opts.gameName, romName: opts.romName,
    sizeBytes: opts.sizeBytes ?? 901120,
    crc32: opts.crc32 ?? null, md5: opts.md5 ?? null, sha1: opts.sha1 ?? null,
    title: opts.title, sortTitle: opts.sortTitle,
    year: opts.year ?? null, publisher: opts.publisher ?? null,
    diskNo: opts.diskNo ?? null, diskCount: opts.diskCount ?? null,
  }).onConflictDoNothing();
  seededIds.push(id);
  return id;
}

export async function cleanupTosec() {
  const db = getDb();
  for (const id of seededIds.splice(0)) {
    try { await db.delete(tosecEntries).where(eq(tosecEntries.id, id)); } catch { /* best effort */ }
  }
}
