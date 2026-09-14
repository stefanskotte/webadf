import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, entitlements } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { demozooImport, demozooProductions, demozooSuggestions } from '@/db/schema/demozoo';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import type { SweepResult } from '@/lib/tosec-sweep';
import { decideDemozoo, isGameSet, matchKeys, type DemozooCandidate, type MatchInput, type MatchVerdict } from './match';
import { applyAutomaticLink } from './apply';
import { IMPORT_ROW_ID } from './import';

const BATCH = 50;

/**
 * Match blobs to Demozoo productions (spec §5). Runs only after an import has
 * been applied, over blobs TOSEC has already decided about and that were not
 * checked since that import -- or since TOSEC last re-decided them (a DAT
 * import or a new upload resets match_checked_at, and phase 2 re-stamps it
 * later than this phase's own stamp).
 *
 * A blob whose matching THROWS keeps its prior Demozoo state and checked-at
 * untouched: a transient read or database error must not demote a verified
 * automatic link. It is skipped for the rest of this run (so the queue behind
 * it still moves) and retried by the next one; the phase reports not-done
 * while any such failure remains.
 */
export async function demozooMatchPhase(spent: () => number, budgetMs: number, out: SweepResult): Promise<boolean> {
  const db = getDb();
  const cursor = (await db.select({ appliedAt: demozooImport.appliedAt }).from(demozooImport)
    .where(eq(demozooImport.id, IMPORT_ROW_ID)).limit(1))[0];
  if (!cursor?.appliedAt) return true;
  const appliedAt = cursor.appliedAt;
  const failedThisRun = new Set<string>();

  while (spent() < budgetMs) {
    const todo = await db.select({
      sha256: blobs.sha256, setName: tosecEntries.setName, title: tosecEntries.title,
      year: tosecEntries.year, publisher: tosecEntries.publisher,
    })
      .from(blobs)
      .leftJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
      .where(and(
        isNotNull(blobs.matchCheckedAt),
        or(
          isNull(blobs.demozooCheckedAt),
          lt(blobs.demozooCheckedAt, appliedAt),
          lt(blobs.demozooCheckedAt, blobs.matchCheckedAt),
        ),
        failedThisRun.size > 0 ? notInArray(blobs.sha256, [...failedThisRun]) : undefined,
      ))
      .limit(BATCH);
    if (todo.length === 0) return failedThisRun.size === 0;

    for (const b of todo) {
      if (spent() >= budgetMs) return false;
      try {
        await matchOne(b, out);
      } catch (err) {
        console.error(`demozoo: matching failed for blob ${b.sha256}`, err);
        failedThisRun.add(b.sha256);
      }
    }
  }
  return false;
}

/** The volume name, or null when the bytes cannot be read or are not a readable ADF. */
async function readVolumeName(sha256: string): Promise<string | null> {
  try {
    const v = readVolume(await diskStore.read(sha256));
    return v.ok ? v.volume.name : null;
  } catch (err) {
    console.error(`demozoo: could not read volume name for blob ${sha256}`, err);
    return null;
  }
}

/**
 * decideDemozoo's TOSEC branch decides on its own (skipped_game, applied, or
 * tosec_title suggestions); only 'none' and volume/filename suggestions come
 * from the fall-through a volume name could still change.
 */
const fellThroughTosec = (v: MatchVerdict) =>
  v.state === 'none' || (v.state === 'suggested' && v.suggestions.some((s) => s.source !== 'tosec_title'));

async function matchOne(
  b: { sha256: string; setName: string | null; title: string | null; year: number | null; publisher: string | null },
  out: SweepResult,
) {
  const db = getDb();
  const tosec = b.setName && b.title ? { setName: b.setName, title: b.title, year: b.year, publisher: b.publisher } : null;
  const input: MatchInput = { tosec, volumeName: null, filenames: [] };

  if (!tosec || !isGameSet(tosec.setName)) {
    input.filenames = (await db.select({ f: entitlements.sourceFilename }).from(entitlements)
      .where(eq(entitlements.sha256, b.sha256))).map((r) => r.f).filter((f): f is string => !!f);
  }

  const byKey = new Map<string, DemozooCandidate[]>();
  const fetched = new Set<string>();
  const loadKeys = async (keys: string[]) => {
    const missing = keys.filter((k) => !fetched.has(k));
    if (missing.length === 0) return;
    for (const k of missing) fetched.add(k);
    const rows = await db.select({
      id: demozooProductions.id, title: demozooProductions.title, titleKey: demozooProductions.titleKey,
      releaseYear: demozooProductions.releaseYear, groups: demozooProductions.groups,
      supertype: demozooProductions.supertype, isGame: demozooProductions.isGame,
    }).from(demozooProductions).where(inArray(demozooProductions.titleKey, missing));
    for (const r of rows) byKey.set(r.titleKey, [...(byKey.get(r.titleKey) ?? []), r]);
  };
  const lookup = (k: string) => byKey.get(k) ?? [];

  // Decide without the disk's bytes first: reading them costs an object-store
  // round trip, and the TOSEC branch never needs them.
  await loadKeys(matchKeys(input));
  let verdict = decideDemozoo(input, lookup);
  if (fellThroughTosec(verdict)) {
    input.volumeName = await readVolumeName(b.sha256);
    if (input.volumeName) {
      await loadKeys(matchKeys(input));
      verdict = decideDemozoo(input, lookup);
    }
  }
  const now = new Date();

  switch (verdict.state) {
    case 'applied':
      // Work before stamp (phase 2's rule): a throw here leaves the blob's
      // prior state for the next run to retry, not a stamped 'applied' whose
      // games never received the link.
      await applyAutomaticLink(b.sha256, verdict.productionId);
      await db.delete(demozooSuggestions).where(eq(demozooSuggestions.sha256, b.sha256));
      await db.update(blobs).set({ demozooState: 'applied', demozooProductionId: verdict.productionId, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      out.demozooApplied++;
      return;
    case 'suggested':
      await db.delete(demozooSuggestions).where(eq(demozooSuggestions.sha256, b.sha256));
      await db.insert(demozooSuggestions)
        .values(verdict.suggestions.map((s) => ({ sha256: b.sha256, productionId: s.productionId, source: s.source })))
        .onConflictDoNothing();
      await db.update(blobs).set({ demozooState: 'suggested', demozooProductionId: null, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      out.demozooSuggested++;
      return;
    case 'skipped_game':
    case 'none':
      await db.delete(demozooSuggestions).where(eq(demozooSuggestions.sha256, b.sha256));
      await db.update(blobs).set({ demozooState: verdict.state, demozooProductionId: null, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      if (verdict.state === 'none') out.demozooNone++; else out.demozooSkippedGame++;
  }
}
