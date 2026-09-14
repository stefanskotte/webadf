import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, entitlements } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { demozooImport, demozooProductions, demozooSuggestions } from '@/db/schema/demozoo';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import type { SweepResult } from '@/lib/tosec-sweep';
import { decideDemozoo, isGameSet, matchKeys, type DemozooCandidate, type MatchInput } from './match';
import { applyAutomaticLink } from './apply';
import { IMPORT_ROW_ID } from './import';

const BATCH = 50;

/**
 * Match blobs to Demozoo productions (spec §5). Runs only after an import has
 * been applied, over blobs TOSEC has already decided about and that were not
 * checked since that import. A failure stamps the blob `none` for this import
 * -- it is retried by the next import, never in a loop tonight.
 */
export async function demozooMatchPhase(spent: () => number, budgetMs: number, out: SweepResult): Promise<boolean> {
  const db = getDb();
  const cursor = (await db.select({ appliedAt: demozooImport.appliedAt }).from(demozooImport)
    .where(eq(demozooImport.id, IMPORT_ROW_ID)).limit(1))[0];
  if (!cursor?.appliedAt) return true;
  const appliedAt = cursor.appliedAt;

  while (spent() < budgetMs) {
    const todo = await db.select({
      sha256: blobs.sha256, setName: tosecEntries.setName, title: tosecEntries.title,
      year: tosecEntries.year, publisher: tosecEntries.publisher,
    })
      .from(blobs)
      .leftJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
      .where(and(
        isNotNull(blobs.matchCheckedAt),
        or(isNull(blobs.demozooCheckedAt), lt(blobs.demozooCheckedAt, appliedAt)),
      ))
      .limit(BATCH);
    if (todo.length === 0) return true;

    for (const b of todo) {
      if (spent() >= budgetMs) return false;
      try {
        await matchOne(b, out);
      } catch (err) {
        console.error(`demozoo: matching failed for blob ${b.sha256}`, err);
        await db.delete(demozooSuggestions).where(eq(demozooSuggestions.sha256, b.sha256));
        await db.update(blobs).set({ demozooState: 'none', demozooProductionId: null, demozooCheckedAt: new Date() })
          .where(eq(blobs.sha256, b.sha256));
        out.demozooNone++;
      }
    }
  }
  return false;
}

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
    const v = readVolume(await diskStore.read(b.sha256));
    input.volumeName = v.ok ? v.volume.name : null;
  }

  const keys = matchKeys(input);
  const rows = keys.length === 0 ? [] : await db.select({
    id: demozooProductions.id, title: demozooProductions.title, titleKey: demozooProductions.titleKey,
    releaseYear: demozooProductions.releaseYear, groups: demozooProductions.groups,
    supertype: demozooProductions.supertype, isGame: demozooProductions.isGame,
  }).from(demozooProductions).where(inArray(demozooProductions.titleKey, keys));
  const byKey = new Map<string, DemozooCandidate[]>();
  for (const r of rows) byKey.set(r.titleKey, [...(byKey.get(r.titleKey) ?? []), r]);

  const verdict = decideDemozoo(input, (k) => byKey.get(k) ?? []);
  const now = new Date();
  await db.delete(demozooSuggestions).where(eq(demozooSuggestions.sha256, b.sha256));

  switch (verdict.state) {
    case 'applied':
      await db.update(blobs).set({ demozooState: 'applied', demozooProductionId: verdict.productionId, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      await applyAutomaticLink(b.sha256, verdict.productionId);
      out.demozooApplied++;
      return;
    case 'suggested':
      await db.insert(demozooSuggestions)
        .values(verdict.suggestions.map((s) => ({ sha256: b.sha256, productionId: s.productionId, source: s.source })))
        .onConflictDoNothing();
      await db.update(blobs).set({ demozooState: 'suggested', demozooProductionId: null, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      out.demozooSuggested++;
      return;
    case 'skipped_game':
    case 'none':
      await db.update(blobs).set({ demozooState: verdict.state, demozooProductionId: null, demozooCheckedAt: now })
        .where(eq(blobs.sha256, b.sha256));
      if (verdict.state === 'none') out.demozooNone++; else out.demozooSkippedGame++;
  }
}
