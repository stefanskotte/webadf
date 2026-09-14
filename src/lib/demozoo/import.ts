import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { demozooImport, demozooProductions, demozooScreenshots } from '@/db/schema/demozoo';
import { demozooExportStore } from '@/lib/storage';
import { chunk } from '@/lib/chunk';
import { fetchExport } from './fetch-export';
import { gzipLines } from './lines';
import { readCopyBlocks } from './copy';
import { extractAmiga, WANTED_TABLES, type DemozooExtract } from './extract';

export const IMPORT_ROW_ID = 1;
/** Operator ruling 2026-09-14: Demozoo is asked at most once a week. */
export const REFETCH_AFTER_MS = 7 * 24 * 3_600_000;
const PRODUCTION_CHUNK = 250;    // 9 columns -> 2,250 bind parameters
const SCREENSHOT_CHUNK = 1_000;  // 5 columns -> 5,000
const DEFAULT_BUDGET_MS = 240_000;
/**
 * An extract smaller than this is not an Amiga catalogue (78,447 productions
 * on 2026-09-14) but an upstream format change, and writing it would delete
 * every production -- cascading away every dismissal and clearing every link.
 */
export const MIN_EXTRACT_PRODUCTIONS = 50_000;
/** ...nor may one shrink the catalogue we already hold by more than a fifth. */
export const MIN_EXTRACT_SHARE_OF_CURRENT = 0.8;

export type ImportCursor = typeof demozooImport.$inferSelect;
export type CronStep = 'fetch' | 'extract' | 'write' | 'idle';

export function nextStep(cursor: ImportCursor | null, now: number): CronStep {
  if (!cursor) return 'fetch';
  const last = cursor.lastAttemptAt?.getTime();
  const weekPassed = last === undefined || now - last >= REFETCH_AFTER_MS;
  // A copy the extract guard refused stays 'fetched' and is re-checked daily;
  // once a week has passed, a new fetch replaces it instead, so a refused
  // export cannot stall imports forever.
  if (cursor.step === 'fetched') return weekPassed ? 'fetch' : 'extract';
  if (cursor.step === 'extracted') return 'write';
  return weekPassed ? 'fetch' : 'idle';
}

/**
 * null when an extract of `extracted` productions may replace a catalogue of
 * `current`; otherwise why not. Guards writeExtract's destructive delete.
 */
export function extractRefusal(extracted: number, current: number): string | null {
  if (extracted < MIN_EXTRACT_PRODUCTIONS) {
    return `extract has ${extracted} productions, fewer than ${MIN_EXTRACT_PRODUCTIONS}`;
  }
  if (current > 0 && extracted < current * MIN_EXTRACT_SHARE_OF_CURRENT) {
    return `extract has ${extracted} productions, fewer than ${MIN_EXTRACT_SHARE_OF_CURRENT * 100}% of the ${current} held`;
  }
  return null;
}

async function currentProductionCount(): Promise<number> {
  const rows = await getDb().select({ n: sql<number>`count(*)::int` }).from(demozooProductions);
  return Number(rows[0]?.n ?? 0);
}

export async function extractFromStream(stream: ReadableStream<Uint8Array>): Promise<DemozooExtract> {
  return extractAmiga(readCopyBlocks(gzipLines(stream), WANTED_TABLES));
}

const excluded = (col: string) => sql.raw(`excluded."${col}"`);

async function readCursor(): Promise<ImportCursor | null> {
  const rows = await getDb().select().from(demozooImport).where(eq(demozooImport.id, IMPORT_ROW_ID)).limit(1);
  return rows[0] ?? null;
}

async function saveCursor(values: Partial<ImportCursor>): Promise<void> {
  await getDb().insert(demozooImport).values({ id: IMPORT_ROW_ID, ...values })
    .onConflictDoUpdate({ target: demozooImport.id, set: values });
}

/**
 * Chunked upserts, resumable: the cursor's offsets advance after every chunk,
 * so a run cut off by its deadline continues where it stopped the next day.
 * Rows are stamped with run_started_at; anything older is gone from Demozoo
 * and is deleted when the run completes -- suggestions and dismissals cascade,
 * and the blob/game links, which have no FK, are cleared explicitly.
 */
export async function writeExtract(
  extract: DemozooExtract, cursor: ImportCursor, deadline: () => boolean,
): Promise<'done' | 'partial'> {
  const db = getDb();
  // Defence in depth behind the extract step's own check: nothing below runs
  // -- above all not the deletes -- for an extract that cannot be a catalogue.
  const refusal = extractRefusal(extract.productions.length, await currentProductionCount());
  if (refusal) throw new Error(`demozoo import: refusing to write: ${refusal}`);
  const stamp = cursor.runStartedAt ?? new Date();

  let written = cursor.productionsWritten;
  for (const part of chunk(extract.productions.slice(written), PRODUCTION_CHUNK)) {
    if (deadline()) return 'partial';
    await db.insert(demozooProductions).values(part.map((p) => ({
      id: p.id, title: p.title, titleKey: p.titleKey, releaseYear: p.releaseYear,
      supertype: p.supertype, types: p.types, groups: p.groups, isGame: p.isGame, importedAt: stamp,
    }))).onConflictDoUpdate({
      target: demozooProductions.id,
      set: {
        title: excluded('title'), titleKey: excluded('title_key'), releaseYear: excluded('release_year'),
        supertype: excluded('supertype'), types: excluded('types'), groups: excluded('groups'),
        isGame: excluded('is_game'), importedAt: excluded('imported_at'),
      },
    });
    written += part.length;
    await saveCursor({ productionsWritten: written });
  }

  let shots = cursor.screenshotsWritten;
  for (const part of chunk(extract.screenshots.slice(shots), SCREENSHOT_CHUNK)) {
    if (deadline()) return 'partial';
    await db.insert(demozooScreenshots).values(part.map((s) => ({ ...s, importedAt: stamp })))
      .onConflictDoUpdate({
        target: demozooScreenshots.id,
        set: {
          productionId: excluded('production_id'), standardUrl: excluded('standard_url'),
          ordinal: excluded('ordinal'), importedAt: excluded('imported_at'),
        },
      });
    shots += part.length;
    await saveCursor({ screenshotsWritten: shots });
  }

  await db.delete(demozooScreenshots).where(lt(demozooScreenshots.importedAt, stamp));
  await db.delete(demozooProductions).where(lt(demozooProductions.importedAt, stamp));
  await db.execute(sql`
    update blobs set demozoo_production_id = null, demozoo_state = null, demozoo_checked_at = null
    where demozoo_production_id is not null
      and not exists (select 1 from demozoo_productions p where p.id = blobs.demozoo_production_id)`);
  await db.execute(sql`
    update games set demozoo_production_id = null, demozoo_link_source = null
    where demozoo_production_id is not null
      and not exists (select 1 from demozoo_productions p where p.id = games.demozoo_production_id)`);
  return 'done';
}

/**
 * The weekly gate as ONE conditional update: true only for the invocation
 * whose update moved last_attempt_at. The insert creates the single row the
 * very first time (a no-op ever after).
 */
async function claimWeeklyFetch(): Promise<boolean> {
  const db = getDb();
  await db.insert(demozooImport).values({ id: IMPORT_ROW_ID }).onConflictDoNothing();
  const claimed = await db.update(demozooImport).set({ lastAttemptAt: sql`now()` })
    .where(and(
      eq(demozooImport.id, IMPORT_ROW_ID),
      or(isNull(demozooImport.lastAttemptAt), lte(demozooImport.lastAttemptAt, sql`now() - interval '7 days'`)),
    ))
    .returning({ id: demozooImport.id });
  return claimed.length > 0;
}

export interface CronReport { steps: Array<{ step: CronStep; ms: number; detail?: string }> }

export async function runDemozooCron(budgetMs: number = DEFAULT_BUDGET_MS): Promise<CronReport> {
  const started = Date.now();
  const deadline = () => Date.now() - started >= budgetMs;
  const report: CronReport = { steps: [] };

  while (!deadline()) {
    const cursor = await readCursor();
    const step = nextStep(cursor, Date.now());
    if (step === 'idle') break;
    const t0 = Date.now();

    if (step === 'fetch') {
      // Claimed atomically, and BEFORE the request: of two overlapping
      // invocations only one fetches, and a failure waits a week like a
      // success does.
      if (!(await claimWeeklyFetch())) {
        report.steps.push({ step, ms: Date.now() - t0, detail: 'not claimed: fetched within the week' });
        break;
      }
      const outcome = await fetchExport(cursor ? { etag: cursor.etag, lastModified: cursor.lastModified } : null);
      if (outcome.status === 'unchanged') {
        report.steps.push({ step, ms: Date.now() - t0, detail: 'unchanged' });
        break;
      }
      await saveCursor({
        step: 'fetched', etag: outcome.etag, lastModified: outcome.lastModified, fetchedAt: new Date(),
      });
      report.steps.push({ step, ms: Date.now() - t0, detail: 'stored' });
      // The ~200 MB download has had its share of this invocation; extract
      // gets a whole one of its own (the next daily run).
      break;
    }

    if (step === 'extract') {
      const stream = await demozooExportStore.readStream('export.sql.gz');
      if (!stream) {
        // Our copy is gone: wait for next week's fetch rather than loop daily.
        await saveCursor({ step: 'applied' });
        report.steps.push({ step, ms: Date.now() - t0, detail: 'export missing from store' });
        break;
      }
      const extract = await extractFromStream(stream);
      const current = await currentProductionCount();
      const refusal = extractRefusal(extract.productions.length, current);
      if (refusal) {
        // Step stays 'fetched': nothing is written, and the next weekly fetch
        // replaces this copy (nextStep).
        console.error(`demozoo import: refusing extract: ${refusal}`);
        report.steps.push({ step, ms: Date.now() - t0, detail: `refused: ${refusal}` });
        break;
      }
      // Captured before encoding so nothing below still references `extract`
      // -- it (and the JSON string built from it) can be released while the
      // putBytes upload of the encoded bytes is in flight.
      const productionCount = extract.productions.length;
      const screenshotCount = extract.screenshots.length;
      await demozooExportStore.putBytes('amiga.json', new TextEncoder().encode(JSON.stringify(extract)));
      await saveCursor({ step: 'extracted', runStartedAt: new Date(), productionsWritten: 0, screenshotsWritten: 0 });
      report.steps.push({ step, ms: Date.now() - t0, detail: `${productionCount} productions, ${screenshotCount} screenshots` });
      continue;
    }

    // write
    const stream = await demozooExportStore.readStream('amiga.json');
    if (!stream) {
      await saveCursor({ step: 'fetched' });   // re-extract from our export copy
      report.steps.push({ step, ms: Date.now() - t0, detail: 'extract missing; re-extracting' });
      continue;
    }
    const extract = (await new Response(stream).json()) as DemozooExtract;
    const result = await writeExtract(extract, cursor!, deadline);
    if (result === 'done') await saveCursor({ step: 'applied', appliedAt: new Date() });
    report.steps.push({ step, ms: Date.now() - t0, detail: result });
    if (result === 'partial') break;
  }
  return report;
}
