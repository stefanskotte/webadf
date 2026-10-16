import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { makeZip } from './__fixtures__/make-zip';
import { TOSEC_DOWNLOADS } from './tosec-fetch-parse';

// A database of its own: the import writes tosec_entries and the fetch state row.
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_tosecfetch_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { runTosecFetch, readTosecFetchState } = await import('./tosec-fetch');

const fx = (n: string) => readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), 'utf8');
const DOWNLOADS = fx('tosec-downloads.html');
const RELEASE_PAGE = fx('tosec-release-2025-03-13.html');
const RELEASE_URL = 'https://www.tosecdev.org/downloads/category/59-2025-03-13';
const PACK_URL = 'https://www.tosecdev.org/downloads/category/59-2025-03-13?download=117:tosec-dat-pack-complete-4743-tosec-v2025-03-13';

function dat(name: string, games: string[]): string {
  return `clrmamepro (\n\tname "${name}"\n\tdescription "${name} (TOSEC-v2025-03-13)"\n\tversion 2025-03-13\n)\n\n` +
    games.map((g, i) => `game (\n\tname "${g}"\n\tdescription "${g}"\n\trom ( name "${g}.adf" size 901120 crc 1A2B3C4${i} )\n)\n`).join('\n');
}
const zip = makeZip([
  { name: 'TOSEC/Commodore Amiga - Games - [ADF] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore Amiga - Games - [ADF]', ['State of the Art (1992)(Spaceballs)(PD)', 'Turrican II (1991)(Rainbow Arts)(Disk 1 of 2)'])), deflate: true },
  { name: 'TOSEC/Commodore Amiga - Demos - [ADF] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore Amiga - Demos - [ADF]', ['Mental Hangover (1991)(Sanity)'])) },
  { name: 'TOSEC/Commodore Amiga - Games - [IPF] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore Amiga - Games - [IPF]', ['Not An ADF (1990)(X)'])) },
  { name: 'TOSEC/Commodore 64 - Games - [D64] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore 64 - Games - [D64]', ['Other System (1985)(Y)'])) },
]);
const zipNoAdf = makeZip([
  { name: 'TOSEC/Commodore Amiga - Games - [IPF] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore Amiga - Games - [IPF]', ['Not An ADF (1990)(X)'])) },
]);

function fake(opts: { downloads?: string; release?: string; pack?: Buffer } = {}) {
  const calls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    calls.push(u);
    signals.push(init?.signal);
    const html = (b: string) => new Response(b, { status: 200 });
    if (u === TOSEC_DOWNLOADS) return html(opts.downloads ?? DOWNLOADS);
    if (u === RELEASE_URL) return html(opts.release ?? RELEASE_PAGE);
    if (u === PACK_URL) return new Response(new Uint8Array(opts.pack ?? zip), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls, signals };
}
const log = () => {};

async function entryCount() {
  const { rows } = await getDb().execute(sql`select count(*)::int as n from tosec_entries`);
  return (rows[0] as { n: number }).n;
}

describe('runTosecFetch', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
  });
  afterAll(async () => {
    await closeDb();
    await admin(`drop database if exists ${DB} with (force)`);
  });

  it('imports the newest release\'s Amiga [ADF] DATs only', async () => {
    const f = fake();
    const r = await runTosecFetch({ fetchImpl: f.impl, log });
    expect(r).toMatchObject({ status: 'imported', release: '2025-03-13', dats: 2, skipped: 0, entries: 3 });
    expect(f.signals).toHaveLength(3);
    expect(f.signals.every((x) => x instanceof AbortSignal)).toBe(true);
    expect(await entryCount()).toBe(3);
    const st = await readTosecFetchState();
    expect(st?.release).toBe('2025-03-13');
    expect(st?.lastResult).toMatch(/^imported 2025-03-13/);
  });

  it('is up to date the second time and does not fetch the pack again', async () => {
    const f = fake();
    const r = await runTosecFetch({ fetchImpl: f.impl, log });
    expect(r).toMatchObject({ status: 'up-to-date', release: '2025-03-13' });
    expect(f.calls).not.toContain(PACK_URL);
    const st = await readTosecFetchState();
    expect(st?.lastResult).toBe('up to date');
    expect(st?.release).toBe('2025-03-13');
  });

  it('fails, keeping the old release, when a newer release has no Complete pack link', async () => {
    const newer = DOWNLOADS.replace('</body>', '<a href="/downloads/category/60-2026-01-01">2026-01-01</a></body>');
    const f = fake({ downloads: newer.includes('60-2026-01-01') ? newer : DOWNLOADS + '<a href="/downloads/category/60-2026-01-01">2026-01-01</a>' });
    const g = (async (input: string | URL | Request) => {
      if (String(input) === 'https://www.tosecdev.org/downloads/category/60-2026-01-01') return new Response('<html>nothing here</html>', { status: 200 });
      return f.impl(input);
    }) as typeof fetch;
    const r = await runTosecFetch({ fetchImpl: g, log });
    expect(r.status).toBe('failed');
    const st = await readTosecFetchState();
    expect(st?.lastResult).toMatch(/^failed: no "DAT Pack - Complete" link/);
    expect(st?.release).toBe('2025-03-13');
  });

  it('fails when the pack holds no Amiga [ADF] DAT, importing nothing', async () => {
    await getDb().execute(sql`delete from tosec_entries`);
    await getDb().execute(sql`update tosec_fetch set release = null`);
    const f = fake({ pack: zipNoAdf });
    const r = await runTosecFetch({ fetchImpl: f.impl, log });
    expect(r).toMatchObject({ status: 'failed', reason: 'the pack holds no Commodore Amiga [ADF] DAT' });
    expect(await entryCount()).toBe(0);
    const st = await readTosecFetchState();
    expect(st?.release).toBeNull();
    expect(st?.lastResult).toBe('failed: the pack holds no Commodore Amiga [ADF] DAT');
  });

  it('fails when the downloads page has no dated release', async () => {
    const f = fake({ downloads: '<html>no releases</html>' });
    const r = await runTosecFetch({ fetchImpl: f.impl, log });
    expect(r).toMatchObject({ status: 'failed', reason: `no dated release on ${TOSEC_DOWNLOADS}` });
    expect((await readTosecFetchState())?.lastResult).toBe(`failed: no dated release on ${TOSEC_DOWNLOADS}`);
  });

  it('skips DATs whose set and version are already loaded, leaving blob verdicts alone, and still records the release', async () => {
    await getDb().execute(sql`update tosec_fetch set release = null`);
    await runTosecFetch({ fetchImpl: fake().impl, log }); // loads the two sets
    await getDb().execute(sql`update tosec_fetch set release = null`);
    await getDb().execute(sql`insert into blobs (sha256, size_bytes, storage_key, match_checked_at, match_state) values ('seedblob', 1, 'k', now(), 'none') on conflict do nothing`);
    const r = await runTosecFetch({ fetchImpl: fake().impl, log });
    expect(r).toMatchObject({ status: 'imported', release: '2025-03-13', dats: 0, skipped: 2 });
    const { rows } = await getDb().execute(sql`select match_checked_at, match_state from blobs where sha256 = 'seedblob'`);
    expect((rows[0] as { match_checked_at: unknown }).match_checked_at).not.toBeNull();
    expect((rows[0] as { match_state: string }).match_state).toBe('none');
    const st = await readTosecFetchState();
    expect(st?.release).toBe('2025-03-13');
    expect(st?.lastResult).toBe('imported 2025-03-13 (0 new DATs, 2 already present)');
  });

  it('keeps the previous release when a later DAT fails to import', async () => {
    await getDb().execute(sql`delete from tosec_entries`);
    await getDb().execute(sql`update tosec_fetch set release = '2024-01-01'`);
    const bad = dat('Commodore Amiga - Demos - [ADF]', ['Huge (1991)(Z)']).replace('size 901120', 'size 99999999999');
    const z = makeZip([
      { name: 'TOSEC/Commodore Amiga - Games - [ADF] (TOSEC-v2025-03-13).dat', data: Buffer.from(dat('Commodore Amiga - Games - [ADF]', ['Fine (1992)(A)'])) },
      { name: 'TOSEC/Commodore Amiga - Demos - [ADF] (TOSEC-v2025-03-13).dat', data: Buffer.from(bad) },
    ]);
    const r = await runTosecFetch({ fetchImpl: fake({ pack: z }).impl, log });
    expect(r.status).toBe('failed');
    const st = await readTosecFetchState();
    expect(st?.release).toBe('2024-01-01');
    expect(st?.lastResult).toMatch(/^failed:/);
  });
});
