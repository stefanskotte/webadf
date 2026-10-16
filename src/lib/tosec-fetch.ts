import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { tosecEntries, tosecFetch } from '@/db/schema/tosec';
import { importDat } from '@/lib/tosec-import';
import { parseDat } from '@/lib/tosec-dat';
import { listZip, readZipEntry } from '@/lib/zip-read';
import { AMIGA_ADF_DAT, TOSEC_DOWNLOADS, completePackLink, newestRelease } from '@/lib/tosec-fetch-parse';
import { webadfUserAgent } from '@/lib/user-agent';

export interface TosecFetchResult { status: 'imported' | 'up-to-date' | 'failed'; release?: string; dats?: number; skipped?: number; entries?: number; reason?: string }

export async function readTosecFetchState() {
  const [row] = await getDb().select().from(tosecFetch).where(eq(tosecFetch.id, 'tosec'));
  return row ?? null;
}

async function record(fields: Partial<typeof tosecFetch.$inferInsert>) {
  await getDb().insert(tosecFetch).values({ id: 'tosec', lastAttemptAt: new Date(), ...fields })
    .onConflictDoUpdate({ target: tosecFetch.id, set: { lastAttemptAt: new Date(), ...fields } });
}

const PAGE_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 180_000;

/** True when tosec_entries holds this exact set and version COMPLETELY (importDat resets every blob verdict, so never redo a finished one; a half-loaded one must be redone). */
async function alreadyLoaded(setName: string, setVersion: string | null, expected: number): Promise<boolean> {
  if (setVersion === null) return false;
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(tosecEntries)
    .where(and(eq(tosecEntries.setName, setName), eq(tosecEntries.setVersion, setVersion)));
  return (row?.n ?? 0) >= expected && expected > 0;
}

/** Monthly (vercel.ts): TOSEC's newest DAT pack, only the Amiga [ADF] DATs, via importDat (spec P3 D6-D7). */
export async function runTosecFetch(opts: { fetchImpl?: typeof fetch; tmpDir?: string; log?: (l: string) => void } = {}): Promise<TosecFetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l) => console.log(l));
  const headers = { 'user-agent': webadfUserAgent() };
  const fail = async (reason: string): Promise<TosecFetchResult> => {
    await record({ lastResult: `failed: ${reason}` });
    log(`tosec-fetch: failed: ${reason}`);
    return { status: 'failed', reason };
  };
  try {
    const list = await f(TOSEC_DOWNLOADS, { headers, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!list.ok) return await fail(`${TOSEC_DOWNLOADS} answered ${list.status}`);
    const newest = newestRelease(await list.text());
    if (!newest) return await fail(`no dated release on ${TOSEC_DOWNLOADS}`);
    const state = await readTosecFetchState();
    if (state?.release && state.release >= newest.date) {
      await record({ lastResult: 'up to date' });
      return { status: 'up-to-date', release: state.release };
    }
    const page = await f(new URL(newest.path, TOSEC_DOWNLOADS).toString(), { headers, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!page.ok) return await fail(`release page ${newest.path} answered ${page.status}`);
    const link = completePackLink(await page.text());
    if (!link) return await fail(`no "DAT Pack - Complete" link on ${newest.path}`);
    const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), 'tosec-'));
    try {
      const zipPath = join(dir, 'pack.zip');
      const res = await f(link, { headers, signal: AbortSignal.timeout(PACK_TIMEOUT_MS) });
      if (!res.ok || !res.body) return await fail(`pack download answered ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
      const dats = (await listZip(zipPath)).filter((e) => AMIGA_ADF_DAT.test(e.name));
      if (dats.length === 0) return await fail('the pack holds no Commodore Amiga [ADF] DAT');
      let entries = 0, fresh = 0, skipped = 0;
      for (const e of dats) {
        const text = (await readZipEntry(zipPath, e)).toString('utf8');
        const head = parseDat(text);
        // importDat dedupes by (setName, romName); count the same way.
        const expected = new Set(head.entries.map((x) => x.romName)).size;
        if (await alreadyLoaded(head.setName, head.setVersion, expected)) { skipped++; continue; }
        entries += (await importDat(text)).imported;
        fresh++;
      }
      const result = fresh === 0 && skipped > 0 ? `imported ${newest.date} (0 new DATs, ${skipped} already present)`
        : `imported ${newest.date} (${fresh} DATs${skipped ? `, ${skipped} already present` : ''}, ${entries} entries)`;
      await record({ release: newest.date, importedAt: new Date(), lastResult: result });
      log(`tosec-fetch: ${result}`);
      return { status: 'imported', release: newest.date, dats: fresh, skipped, entries };
    } finally { await rm(dir, { recursive: true, force: true }); }
  } catch (e) {
    return fail((e as Error).message);
  }
}
