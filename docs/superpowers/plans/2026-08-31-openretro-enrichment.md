# OpenRetro Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the catalog with OpenRetro's publisher, year, developer, tags, chipset and images, matched exactly by the SHA-1 already stored on every blob.

**Architecture:** Metadata arrives as an uploaded `Amiga.sqlite` (no API calls), parsed with Node's built-in `node:sqlite`. Images are fetched on demand from `openretro.org/image/<sha1>?size=N`, one at a time, and stored in this project's own Blob storage. Enrichment is **phase 3 of the existing sweeper**, inheriting its budget, cursor and admin surface.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Components) · React 19.2 · Tailwind 4 · shadcn v4 (**Base UI, not Radix**) · Drizzle 0.45 · Postgres (Neon HTTP) · `node:sqlite` (built-in, no dependency) · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-08-31-openretro-enrichment-design.md` — **§11 carries the measured structure of the real file; read it before Task 1.**

## Global Constraints

- **Never clear a blob's hashes.** Only enrichment columns are ever reset. Hashing means re-reading every blob out of object storage.
- **Never re-derive `games.id` or `disks.id`.** `disks.id` descends from `games.id`, and `devices.desiredDiskId` is plain text with no FK that `readDesired` joins on — re-keying makes that join return nothing, and "no disk desired" **is eject**. A metadata pass must never be observable as ejecting a disk from real hardware.
- **`blobs` is global, content-addressed, and never deleted.**
- **A human-edited game is never overwritten.** `MACHINE_SOURCES = ['filename','tosec']` in `src/lib/tosec-apply.ts`; enrichment adds `'openretro'` to the machine set. Anything else, including `NULL`, is protected.
- **`db.transaction()` THROWS on neon-http**; `db.batch()` is the atomic primitive. `getDb().execute()` returns `{ rows }`, never an array.
- **Vitest never opens a database connection** and has no `DATABASE_URL`. Pure logic → Vitest; anything touching Postgres or a page → Playwright.
- **No test may make a live third-party request.** Image fetching is exercised against a local fixture.
- **`Amiga.sqlite` is gitignored** (`/Amiga.sqlite`, `*.sqlite`) and must never be committed — it is 28.6 MB.
- Next 16: `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — never import them.
- **shadcn v4 here is Base UI, not Radix.**
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text; amber text is `--amber-text` (`#a8560f`).
- Every e2e spec cleans up what it seeded. The suite runs **`workers: 1`** against a live database.
- Run `pnpm vitest run`, `pnpm build` and the affected e2e before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/openretro-db.ts` | **Create.** Read `Amiga.sqlite` bytes → typed records. The only file that knows about zlib, BLOB uuids or `_type`. |
| `src/lib/openretro-db.test.ts` | **Create.** Vitest against a fixture database built in the test. |
| `src/db/schema/openretro.ts` | **Create.** `openretroEntries`, `openretroImages`. |
| `src/db/schema/catalog.ts` | **Modify.** `blobs` enrichment cursor; `games` gains `description`, `history`, `developer`, `players`, and per-field sources. |
| `src/lib/openretro-import.ts` | **Create.** Persist parsed records; reset the enrich cursor. |
| `src/lib/openretro-apply.ts` | **Create.** Apply one entry to a tenant's catalog. Its own file because it writes `games`. |
| `src/lib/openretro-images.ts` | **Create.** Fetch and store one image, politely. The only file that talks to openretro.org. |
| `src/lib/tosec-sweep.ts` | **Modify.** Phase 3, plus `enriched` on `SweepResult` and the `ScanStatus` counts. |
| `src/app/api/admin/openretro/route.ts` | **Create.** `POST` the `.sqlite` upload (binary). |
| `src/app/(admin)/admin/scan/page.tsx` | **Modify.** Enrichment tiles and the upload control. |
| `src/components/admin/openretro-upload.tsx` | **Create.** Client. |
| `src/app/(app)/games/[id]/page.tsx` | **Modify.** Render the enriched data. |
| `src/lib/queries.ts` | **Modify.** `getGame` returns the new fields and images. |
| `e2e/openretro.spec.ts` | **Create.** |

---

### Task 1: Read `Amiga.sqlite`

**Files:**
- Create: `src/lib/openretro-db.ts`, `src/lib/openretro-db.test.ts`

**Interfaces:**
- Produces:

```ts
export interface OpenRetroVariant {
  uuid: string; parentUuid: string | null;
  fileSha1s: string[];               // lowercase, from file_list[].sha1
  chipset: string | null; videoStandard: string | null;
  protection: string | null; variantName: string | null; source: string | null;
}
export interface OpenRetroGame {
  uuid: string; gameName: string; slug: string | null;
  publisher: string | null; developer: string | null; year: number | null;
  languages: string | null; players: string | null; tags: string | null;
  frontSha1: string | null; titleSha1: string | null; screenshotSha1s: string[];
  holUrl: string | null; mobygamesUrl: string | null; lemonUrl: string | null;
  wikipediaUrl: string | null; longplayUrl: string | null;
}
export interface OpenRetroData { games: OpenRetroGame[]; variants: OpenRetroVariant[]; version: number | null }
export function readOpenRetroDb(bytes: Uint8Array): OpenRetroData;
```

**Spec §11 is the authority for the format.** Facts that will bite if ignored: `game.data` is **zlib-deflate**, not gzip; `uuid` is a 16-byte **BLOB** while `parent_uuid` is a hyphenated string; exactly one row has empty `data`.

- [ ] **Step 1: Write the failing test**

`src/lib/openretro-db.test.ts`. It builds a fixture database in a temp file so the suite carries no binary:

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOpenRetroDb } from './openretro-db';

/** 16-byte BLOB, as the real file stores uuids. */
function uuidBlob(hyphenated: string): Buffer {
  return Buffer.from(hyphenated.replace(/-/g, ''), 'hex');
}

function buildFixture(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'oagd-'));
  const path = join(dir, 'Amiga.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table game (id integer primary key, uuid blob, data blob)');
  db.exec('create table metadata (version integer, games_version integer, database_version integer)');
  db.prepare('insert into metadata values (?, ?, ?)').run(19, 0, 17);

  const parentUuid = 'dd6a826f-7106-55d3-9503-435bdb6a2e9c';
  const parent = {
    _type: 1, game_name: 'Pinball Fantasies [AGA]', __link_name: 'pinball-fantasies-aga',
    publisher: '21st Century', developer: 'Digital Illusions', year: 1993,
    languages: 'en', players: '1 - 8 (1)', tags: 'pinball, scrolling',
    front_sha1: 'a'.repeat(40), title_sha1: 'b'.repeat(40),
    screen1_sha1: 'c'.repeat(40), screen2_sha1: 'd'.repeat(40),
    hol_url: 'http://hol.abime.net/1056',
    mobygames_url: 'http://www.mobygames.com/game/amiga/pinball-fantasies',
  };
  const variant = {
    _type: 2, parent_uuid: parentUuid, chipset: 'AGA', video_standard: 'NTSC',
    protection: 'Manual', variant_name: 'IPF, AGA, US, 2025',
    __source: 'Commodore Amiga - Games - SPS',
    file_list: JSON.stringify([
      { name: 'PF1.adf', sha1: '1'.repeat(40) },
      { name: 'PF2.adf', sha1: '2'.repeat(40) },
    ]),
  };

  const ins = db.prepare('insert into game (uuid, data) values (?, ?)');
  ins.run(uuidBlob(parentUuid), deflateSync(Buffer.from(JSON.stringify(parent))));
  ins.run(uuidBlob('11111111-2222-3333-4444-555555555555'), deflateSync(Buffer.from(JSON.stringify(variant))));
  ins.run(uuidBlob('99999999-9999-9999-9999-999999999999'), Buffer.alloc(0)); // the empty row
  db.close();
  return readFileSync(path);
}

describe('readOpenRetroDb', () => {
  const data = readOpenRetroDb(buildFixture());

  it('reads the metadata version', () => {
    expect(data.version).toBe(19);
  });

  it('separates parents from variants by _type', () => {
    expect(data.games).toHaveLength(1);
    expect(data.variants).toHaveLength(1);
  });

  it('inflates zlib-deflate, not gzip', () => {
    // The whole point: a gunzip-based reader throws on this data.
    expect(data.games[0].gameName).toBe('Pinball Fantasies [AGA]');
  });

  it('converts the uuid BLOB to the hyphenated form parent_uuid uses', () => {
    // If this is wrong, every variant silently orphans and nothing ever matches.
    expect(data.games[0].uuid).toBe('dd6a826f-7106-55d3-9503-435bdb6a2e9c');
    expect(data.variants[0].parentUuid).toBe('dd6a826f-7106-55d3-9503-435bdb6a2e9c');
  });

  it('extracts every sha1 from file_list, lowercased', () => {
    expect(data.variants[0].fileSha1s).toEqual(['1'.repeat(40), '2'.repeat(40)]);
  });

  it('collects screenshots in order and skips absent ones', () => {
    expect(data.games[0].screenshotSha1s).toEqual(['c'.repeat(40), 'd'.repeat(40)]);
  });

  it('keeps the outbound links, including hol_url', () => {
    // hol_url is why the deferred Hall of Light increment needs no title matching.
    expect(data.games[0].holUrl).toBe('http://hol.abime.net/1056');
    expect(data.games[0].wikipediaUrl).toBeNull();
  });

  it('carries the parent fields that fill genre and chipset', () => {
    expect(data.games[0].tags).toBe('pinball, scrolling');
    expect(data.variants[0].chipset).toBe('AGA');
  });

  it('skips a row with empty data rather than throwing', () => {
    expect(data.games.length + data.variants.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/openretro-db.test.ts`
Expected: FAIL — cannot resolve `./openretro-db`.

- [ ] **Step 3: Implement**

`src/lib/openretro-db.ts`:

```ts
// Reads the Amiga.sqlite that FS-UAE Launcher syncs from OpenRetro. This is
// the ONLY file that knows the on-disk shape -- zlib framing, BLOB uuids,
// _type discrimination -- so everything downstream sees plain records.
//
// Uses node:sqlite, built into Node, so this adds no dependency (the same
// reasoning that keeps crc32 and adfmfm hand-written).
//
// Structure measured from the operator's real 28.6 MB file; see the design
// doc's section 11. The three facts that break a naive reader:
//   * game.data is zlib-DEFLATE (789c), not gzip. gunzip throws on it.
//   * uuid is a 16-byte BLOB, while parent_uuid inside the JSON is a
//     hyphenated string. Without converting, every variant orphans silently.
//   * one row has empty data and must be skipped, not treated as corrupt.

import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface OpenRetroVariant {
  uuid: string; parentUuid: string | null;
  fileSha1s: string[];
  chipset: string | null; videoStandard: string | null;
  protection: string | null; variantName: string | null; source: string | null;
}

export interface OpenRetroGame {
  uuid: string; gameName: string; slug: string | null;
  publisher: string | null; developer: string | null; year: number | null;
  languages: string | null; players: string | null; tags: string | null;
  frontSha1: string | null; titleSha1: string | null; screenshotSha1s: string[];
  holUrl: string | null; mobygamesUrl: string | null; lemonUrl: string | null;
  wikipediaUrl: string | null; longplayUrl: string | null;
}

export interface OpenRetroData { games: OpenRetroGame[]; variants: OpenRetroVariant[]; version: number | null }

/** 16 raw bytes -> the hyphenated form parent_uuid uses. */
function toUuid(blob: Uint8Array): string {
  const h = Buffer.from(blob).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};
const sha = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
};

export function readOpenRetroDb(bytes: Uint8Array): OpenRetroData {
  // node:sqlite opens a path, not a buffer, so the upload is spilled to a
  // temp file and removed again. Deliberate: the alternative is a WASM
  // SQLite build, which would be a dependency for no gain.
  const dir = mkdtempSync(join(tmpdir(), 'oagd-'));
  const path = join(dir, 'db.sqlite');
  writeFileSync(path, bytes);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    let version: number | null = null;
    try {
      const m = db.prepare('select version from metadata limit 1').get() as { version?: number } | undefined;
      version = typeof m?.version === 'number' ? m.version : null;
    } catch { /* a file without a metadata table is still usable */ }

    const games: OpenRetroGame[] = [];
    const variants: OpenRetroVariant[] = [];

    for (const row of db.prepare('select uuid, data from game').all() as Array<{ uuid: Uint8Array; data: Uint8Array }>) {
      const raw = Buffer.from(row.data ?? []);
      if (raw.length === 0) continue;            // the one empty row
      let j: Record<string, unknown>;
      try { j = JSON.parse(inflateSync(raw).toString('utf8')); } catch { continue; }
      const uuid = toUuid(row.uuid);

      if (j._type === 2) {
        let fileSha1s: string[] = [];
        try {
          const list = JSON.parse(String(j.file_list ?? '[]')) as Array<{ sha1?: string }>;
          fileSha1s = list.map((f) => sha(f.sha1)).filter((s): s is string => s !== null);
        } catch { fileSha1s = []; }
        variants.push({
          uuid, parentUuid: str(j.parent_uuid), fileSha1s,
          chipset: str(j.chipset), videoStandard: str(j.video_standard),
          protection: str(j.protection), variantName: str(j.variant_name),
          source: str(j.__source),
        });
      } else if (j._type === 1) {
        const screenshotSha1s: string[] = [];
        for (let i = 1; i <= 8; i++) {
          const s = sha(j[`screen${i}_sha1`]);
          if (s) screenshotSha1s.push(s);
        }
        const year = Number(j.year);
        games.push({
          uuid, gameName: str(j.game_name) ?? '(unnamed)', slug: str(j.__link_name),
          publisher: str(j.publisher), developer: str(j.developer),
          year: Number.isFinite(year) && year > 0 ? year : null,
          languages: str(j.languages), players: str(j.players), tags: str(j.tags),
          frontSha1: sha(j.front_sha1), titleSha1: sha(j.title_sha1), screenshotSha1s,
          holUrl: str(j.hol_url), mobygamesUrl: str(j.mobygames_url),
          lemonUrl: str(j.lemon_url), wikipediaUrl: str(j.wikipedia_url),
          longplayUrl: str(j.longplay_url),
        });
      }
    }
    db.close();
    return { games, variants, version };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/openretro-db.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove it against the real file**

The operator's `Amiga.sqlite` sits at the repo root and is gitignored. Write a throwaway script, run it, report the numbers in your report, then **delete the script**:

```bash
# Expected from the design doc's section 11: ~3,697 games, ~17,742 variants, version 19.
```

If your counts differ materially, **stop and report** — the file may be a different sync version and the plan's assumptions need revisiting.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/openretro-db.ts src/lib/openretro-db.test.ts
git commit -m "Read OpenRetro's Amiga.sqlite without adding a dependency"
```

---

### Task 2: Schema

**Files:**
- Create: `src/db/schema/openretro.ts`
- Modify: `src/db/schema/catalog.ts`, `src/db/index.ts`

**Interfaces:**
- Produces: `openretroEntries`, `openretroImages`; `blobs.openretroEntryId` / `.enrichState` / `.enrichCheckedAt`; `games.description` / `.history` / `.developer` / `.players` / `.factsSource` / `.proseSource`.

- [ ] **Step 1: Create the tables**

`src/db/schema/openretro.ts`:

```ts
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * GLOBAL, not per-tenant -- the same class as blobs and tosec_entries. An
 * OpenRetro record describes bytes, so one import serves every organization.
 *
 * One row per PARENT game (_type 1). Variant rows are not stored: their only
 * durable contribution is the sha1 -> parent mapping, which is flattened into
 * openretro_disk_sha1 below, plus chipset, which is copied onto the entry.
 */
export const openretroEntries = pgTable('openretro_entries', {
  uuid: text('uuid').primaryKey(),
  gameName: text('game_name').notNull(),
  slug: text('slug'),
  publisher: text('publisher'),
  developer: text('developer'),
  year: integer('year'),
  languages: text('languages'),
  players: text('players'),
  tags: text('tags'),
  chipset: text('chipset'),
  frontSha1: text('front_sha1'),
  titleSha1: text('title_sha1'),
  // Comma-joined, in order. MUST be persisted, not held in memory: the import
  // and the sweeper that fetches these images are separate requests, so an
  // in-memory list would be gone by the time anything needed it.
  screenshotSha1s: text('screenshot_sha1s'),
  // Outbound links, stored verbatim. hol_url is the one that matters: it makes
  // the deferred Hall of Light increment an exact lookup instead of a title
  // search. The rest cost nothing and are useful on a game page.
  holUrl: text('hol_url'),
  mobygamesUrl: text('mobygames_url'),
  lemonUrl: text('lemon_url'),
  wikipediaUrl: text('wikipedia_url'),
  longplayUrl: text('longplay_url'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
});

/** sha1 of a disk -> the parent entry it belongs to. Flattened from variants. */
export const openretroDiskSha1 = pgTable('openretro_disk_sha1', {
  sha1: text('sha1').notNull(),
  entryUuid: text('entry_uuid').notNull(),
}, (t) => [
  index('oagd_sha1_idx').on(t.sha1),
  index('oagd_entry_idx').on(t.entryUuid),
]);

/**
 * One row per image we have actually stored, keyed by OpenRetro's own sha1.
 * `kind` is 'front' | 'title' | 'screenshot'. Global for the same reason the
 * entries are: the same cover serves every tenant holding that game.
 */
export const openretroImages = pgTable('openretro_images', {
  sha1: text('sha1').primaryKey(),
  entryUuid: text('entry_uuid').notNull(),
  kind: text('kind').notNull(),
  ordinal: integer('ordinal').notNull().default(0),
  storageKey: text('storage_key').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sourceUrl: text('source_url').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('oagd_img_entry_idx').on(t.entryUuid)]);
```

- [ ] **Step 2: Extend `blobs` and `games`**

In `src/db/schema/catalog.ts`, add to `blobs` (keeping every existing column):

```ts
  // Enrichment cursor. Mirrors tosecEntryId / matchState / matchCheckedAt
  // exactly, so the sweeper's resumable pattern applies unchanged. No foreign
  // key, for the same reason: a re-import may drop an entry and a dangling
  // reference must degrade to "unenriched", never block.
  openretroEntryId: text('openretro_entry_id'),
  enrichState: text('enrich_state'),            // 'enriched' | 'none' | 'ambiguous'
  enrichCheckedAt: timestamp('enrich_checked_at', { withTimezone: true }),
```

and to its index list: `index('blobs_enrich_checked_idx').on(t.enrichCheckedAt),`

Add to `games`:

```ts
  developer: text('developer'),
  players: text('players'),
  // Empty until a Hall of Light increment fills them. Added now so that
  // increment needs no migration -- OpenRetro carries hol_url, so it will be
  // an exact lookup rather than a title search.
  description: text('description'),
  history: text('history'),
  // Which source last wrote the facts, and which wrote the prose. Separate,
  // so OpenRetro's publisher/year survive a later prose import and vice versa.
  factsSource: text('facts_source'),
  proseSource: text('prose_source'),
```

- [ ] **Step 3: Register the schema**

In `src/db/index.ts`, `import * as openretro from './schema/openretro';` and spread it into `schema`.

- [ ] **Step 4: Generate the migration — do NOT push**

Run `pnpm db:generate` and **paste the complete SQL into your report**. Do **not** run `pnpm db:push`: it mutates the live database that serves production. The controller reviews the SQL and applies it.

If the SQL contains a `DROP`, a `NOT NULL` without a default, or a type change, say so prominently — every column added here must be nullable.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run && pnpm build
git add src/db/schema/openretro.ts src/db/schema/catalog.ts src/db/index.ts drizzle
git commit -m "Add openretro_entries, the sha1 index, images and the enrichment cursor"
```

---

### Task 3: Import an uploaded `Amiga.sqlite`

**Files:**
- Create: `src/lib/openretro-import.ts`, `src/app/api/admin/openretro/route.ts`

**Interfaces:**
- Consumes: `readOpenRetroDb` (Task 1), the tables (Task 2), `requireSuperAdmin`.
- Produces: `export async function importOpenRetro(bytes: Uint8Array): Promise<{ games: number; sha1s: number; version: number | null }>`

- [ ] **Step 1: Implement the importer**

`src/lib/openretro-import.ts`:

```ts
import { sql, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { openretroEntries, openretroDiskSha1 } from '@/db/schema/openretro';
import { readOpenRetroDb } from '@/lib/openretro-db';
import { chunk } from '@/lib/chunk';

const INSERT_CHUNK = 250;
const sqlExcluded = (col: string) => sql.raw(`excluded."${col}"`);

/**
 * Load an uploaded Amiga.sqlite. Idempotent: entries are keyed by OpenRetro's
 * own uuid, so re-importing a newer sync updates in place.
 *
 * A variant's chipset is copied onto its parent entry. Variants are not stored
 * as rows: their durable contribution is the sha1 -> parent mapping.
 */
export async function importOpenRetro(bytes: Uint8Array) {
  const data = readOpenRetroDb(bytes);
  const db = getDb();

  const chipsetByParent = new Map<string, string>();
  for (const v of data.variants) {
    if (v.parentUuid && v.chipset && !chipsetByParent.has(v.parentUuid)) {
      chipsetByParent.set(v.parentUuid, v.chipset);
    }
  }

  // Deduped by uuid before chunking, following ingest/complete's precedent --
  // a duplicate key inside one chunk makes Postgres abort the whole INSERT.
  const rows = [...new Map(data.games.map((g) => [g.uuid, {
    uuid: g.uuid, gameName: g.gameName, slug: g.slug,
    publisher: g.publisher, developer: g.developer, year: g.year,
    languages: g.languages, players: g.players, tags: g.tags,
    chipset: chipsetByParent.get(g.uuid) ?? null,
    frontSha1: g.frontSha1, titleSha1: g.titleSha1,
    screenshotSha1s: g.screenshotSha1s.length > 0 ? g.screenshotSha1s.join(',') : null,
    holUrl: g.holUrl, mobygamesUrl: g.mobygamesUrl, lemonUrl: g.lemonUrl,
    wikipediaUrl: g.wikipediaUrl, longplayUrl: g.longplayUrl,
  }])).values()];

  for (const part of chunk(rows, INSERT_CHUNK)) {
    await db.insert(openretroEntries).values(part).onConflictDoUpdate({
      target: openretroEntries.uuid,
      set: {
        gameName: sqlExcluded('game_name'), slug: sqlExcluded('slug'),
        publisher: sqlExcluded('publisher'), developer: sqlExcluded('developer'),
        year: sqlExcluded('year'), languages: sqlExcluded('languages'),
        players: sqlExcluded('players'), tags: sqlExcluded('tags'),
        chipset: sqlExcluded('chipset'),
        frontSha1: sqlExcluded('front_sha1'), titleSha1: sqlExcluded('title_sha1'),
        screenshotSha1s: sqlExcluded('screenshot_sha1s'),
        holUrl: sqlExcluded('hol_url'), mobygamesUrl: sqlExcluded('mobygames_url'),
        lemonUrl: sqlExcluded('lemon_url'), wikipediaUrl: sqlExcluded('wikipedia_url'),
        longplayUrl: sqlExcluded('longplay_url'),
      },
    });
  }

  // The sha1 index is rebuilt wholesale: a variant can move between parents
  // between syncs, and reconciling that incrementally is more code than
  // rebuilding a table this size.
  await db.execute(sql`delete from openretro_disk_sha1`);
  const pairs = [...new Map(data.variants.flatMap((v) =>
    v.parentUuid ? v.fileSha1s.map((s) => [`${s}:${v.parentUuid}`, { sha1: s, entryUuid: v.parentUuid! }] as const) : [],
  )).values()];
  for (const part of chunk(pairs, INSERT_CHUNK)) {
    await db.insert(openretroDiskSha1).values(part);
  }

  // A new sync invalidates every prior enrichment verdict, exactly as a DAT
  // import invalidates every match verdict. Hashes are NOT touched.
  await db.update(blobs).set({
    enrichCheckedAt: null, enrichState: null, openretroEntryId: null,
  }).where(isNotNull(blobs.enrichCheckedAt));

  return { games: rows.length, sha1s: pairs.length, version: data.version };
}
```

Note `screenshotSha1s` is persisted on the entry as a comma-joined string. It **must** be: the import and the sweep that fetches those images are different requests, so anything held only in memory is gone before it is needed. `openretro_images` records only images actually stored locally, which is a different thing from the list of images that exist upstream.

- [ ] **Step 2: Add the route**

`src/app/api/admin/openretro/route.ts`:

```ts
import { requireSuperAdmin } from '@/lib/superadmin';
import { importOpenRetro } from '@/lib/openretro-import';

// A real Amiga.sqlite is ~29 MB and parsing 21k zlib blobs is CPU-bound.
export const maxDuration = 300;

/**
 * Import an uploaded Amiga.sqlite.
 *
 * Reads the body as BINARY -- unlike /api/admin/tosec, which takes text.
 * requireSuperAdmin() is called here and not merely in the (admin) layout: a
 * page render and a later fetch are separate requests.
 */
export async function POST(request: Request) {
  await requireSuperAdmin();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return Response.json({ error: 'empty' }, { status: 400 });
  // "SQLite format 3\0" -- reject anything that is not a database before
  // handing 29 MB of who-knows-what to the parser.
  const magic = Buffer.from(bytes.subarray(0, 15)).toString('latin1');
  if (magic !== 'SQLite format 3') return Response.json({ error: 'not_sqlite' }, { status: 400 });

  const result = await importOpenRetro(bytes);
  if (result.games === 0) return Response.json({ error: 'no_games', ...result }, { status: 400 });
  return Response.json(result);
}
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/openretro-import.ts src/app/api/admin/openretro
git commit -m "Import an uploaded Amiga.sqlite through the admin plane"
```

---

### Task 4: Apply an entry to the catalog

**Files:**
- Create: `src/lib/openretro-apply.ts`
- Modify: `src/lib/tosec-apply.ts` (add `'openretro'` to `MACHINE_SOURCES`)

**Interfaces:**
- Produces: `export async function applyEnrichment(sha256: string, entryUuid: string): Promise<{ gamesUpdated: number }>`

**Read `src/lib/tosec-apply.ts` first.** This file follows it deliberately: same batch usage, same authority rule, and **the same absolute prohibition on writing any id column**.

- [ ] **Step 1: Implement**

`src/lib/openretro-apply.ts`:

```ts
// Applies one OpenRetro entry to every tenant's game rows for a sha256.
//
// IDS ARE NEVER WRITTEN HERE. Not games.id, not disks.id, and never
// devices.desiredDiskId or mountedDiskId. See tosec-apply.ts's header for the
// full reasoning: a re-keyed disk makes readDesired's join return nothing, and
// "no disk desired" IS eject in this protocol.
//
// This file only ever UPDATEs metadata columns on games. It creates nothing,
// deletes nothing, and merges nothing -- unlike tosec-apply, an enrichment
// cannot change a game's identity, so there is no duplicate to collapse.

import { and, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { openretroEntries } from '@/db/schema/openretro';
import { MACHINE_SOURCES } from '@/lib/tosec-apply';

export async function applyEnrichment(sha256: string, entryUuid: string) {
  const db = getDb();
  const rows = await db.select().from(openretroEntries).where(eq(openretroEntries.uuid, entryUuid)).limit(1);
  const e = rows[0];
  if (!e) return { gamesUpdated: 0 };

  const affected = await db
    .select({ gameId: disks.gameId })
    .from(disks)
    .where(eq(disks.sha256, sha256));
  const gameIds = [...new Set(affected.map((a) => a.gameId))];
  if (gameIds.length === 0) return { gamesUpdated: 0 };

  const stmts: BatchItem<'pg'>[] = gameIds.map((gameId) =>
    // Facts only. title/sortTitle/year are TOSEC's to own -- OpenRetro's
    // game_name carries decorations like "[AGA]" that would fight the
    // canonical TOSEC title, so it is deliberately not written here.
    db.update(games).set({
      publisher: e.publisher, developer: e.developer, players: e.players,
      genre: e.tags, chipset: e.chipset, factsSource: 'openretro',
    }).where(and(
      eq(games.id, gameId),
      // The authority rule: a human-edited row is never overwritten.
      inArray(games.metadataSource, MACHINE_SOURCES),
    )),
  );

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return { gamesUpdated: gameIds.length };
}
```

In `src/lib/tosec-apply.ts`, export the constant and add the new source:

```ts
export const MACHINE_SOURCES = ['filename', 'tosec', 'openretro'];
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/openretro-apply.ts src/lib/tosec-apply.ts
git commit -m "Apply OpenRetro facts to the catalog, never touching identity"
```

---

### Task 5: Fetch and store images

**Files:**
- Create: `src/lib/openretro-images.ts`

**Interfaces:**
- Produces: `export async function ensureImage(entryUuid: string, sha1: string, kind: 'front' | 'title' | 'screenshot', ordinal: number): Promise<{ stored: boolean; bytes: number }>`

- [ ] **Step 1: Implement**

`src/lib/openretro-images.ts`:

```ts
// The ONLY file in this project that makes a request to openretro.org.
//
// openretro.org is a volunteer-run community database, not a paid API. Every
// rule below exists for that reason and none of them is optional:
//   * one request at a time, never in parallel, with a delay between;
//   * a User-Agent that says who we are, so its operators can find us;
//   * never re-fetch an image already stored.
// The caller additionally enforces a hard cap per sweep run.

import { eq } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { getDb } from '@/db';
import { openretroImages } from '@/db/schema/openretro';

/**
 * Server-side resize. Measured on a real cover: full size is 1,029,484 bytes,
 * ?size=400 is 381,535 -- a 63% saving. Note ?width= is silently IGNORED and
 * serves full size, and ?w= returns a 500, so this parameter name is the one
 * that works and getting it wrong costs three times the storage.
 */
const IMAGE_SIZE = 400;
const DELAY_MS = 500;
const UA = 'webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function imageUrl(sha1: string): string {
  return `https://openretro.org/image/${sha1}?size=${IMAGE_SIZE}`;
}

export async function ensureImage(
  entryUuid: string, sha1: string,
  kind: 'front' | 'title' | 'screenshot', ordinal: number,
) {
  const db = getDb();
  const existing = await db.select({ sha1: openretroImages.sha1 })
    .from(openretroImages).where(eq(openretroImages.sha1, sha1)).limit(1);
  if (existing.length > 0) return { stored: false, bytes: 0 };

  const url = imageUrl(sha1);
  await wait(DELAY_MS);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`openretro image ${sha1}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Stored under OpenRetro's own sha1, in a key namespace separate from the
  // ADFs (which live under adf/<sha256>).
  const key = `oagd/${sha1}`;
  await put(key, bytes, {
    access: 'public', contentType: res.headers.get('content-type') ?? 'image/png',
    addRandomSuffix: false, allowOverwrite: false,
  });

  await db.insert(openretroImages).values({
    sha1, entryUuid, kind, ordinal, storageKey: key,
    sizeBytes: bytes.byteLength, sourceUrl: url,
  }).onConflictDoNothing();

  return { stored: true, bytes: bytes.byteLength };
}
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/openretro-images.ts
git commit -m "Fetch OpenRetro images politely, at a bounded size"
```

---

### Task 6: Sweeper phase 3

**Files:**
- Modify: `src/lib/tosec-sweep.ts`

**Interfaces:**
- Produces: `SweepResult` gains **`enriched`, `enrichNone`, `enrichAmbiguous`, `imagesStored`, `imageBytes`** — all five, matching the counters the phase-3 code below increments. `ScanStatus` gains `enriched`, `enrichNone`, `enrichAmbiguous`, `enrichUnchecked`, `openretroEntries`, `imagesStored`, `imageBytes`.

Add them to the `SweepResult` interface and to the zero-initialised `out` object at the top of `sweep()` before writing the phase, or the counters below will not typecheck.

- [ ] **Step 1: Add the phase**

After phase 2 in `sweep()`, add phase 3. It follows phase 2's shape exactly — cursor `enrichCheckedAt IS NULL`, per-blob `try/catch` that does **not** stamp on a fetch failure, and the budget checked between items:

```ts
  // Phase 3 -- enrich. Runs last: a blob's TOSEC identity is useful context
  // when a human reviews an enrichment miss, and all three phases share one
  // budget.
  let imageBudget = IMAGE_CAP_PER_RUN;
  while (spent() < budgetMs) {
    const todo = await db.select({ sha256: blobs.sha256, sha1: blobs.sha1 })
      .from(blobs)
      .where(and(isNull(blobs.enrichCheckedAt), sql`${blobs.sha1} is not null`))
      .limit(ENRICH_BATCH);
    if (todo.length === 0) { out.done = out.done && true; break; }

    for (const b of todo) {
      if (spent() >= budgetMs) break;
      try {
        const hit = await db.select({ entryUuid: openretroDiskSha1.entryUuid })
          .from(openretroDiskSha1).where(eq(openretroDiskSha1.sha1, b.sha1!));
        const uuids = [...new Set(hit.map((h) => h.entryUuid))];

        if (uuids.length === 0) {
          await db.update(blobs).set({ enrichState: 'none', enrichCheckedAt: new Date(), openretroEntryId: null })
            .where(eq(blobs.sha256, b.sha256));
          out.enrichNone++;
          continue;
        }
        if (uuids.length > 1) {
          await db.update(blobs).set({ enrichState: 'ambiguous', enrichCheckedAt: new Date(), openretroEntryId: null })
            .where(eq(blobs.sha256, b.sha256));
          out.enrichAmbiguous++;
          continue;
        }

        const uuid = uuids[0];
        await applyEnrichment(b.sha256, uuid);
        if (imageBudget > 0) {
          imageBudget -= await fetchEntryImages(uuid, out);
        }
        // Stamped only after the work succeeded -- the same ordering phase 2
        // uses, and for the same reason: a stamp before a throw is
        // unrecoverable, since the cursor never revisits it.
        await db.update(blobs).set({ enrichState: 'enriched', enrichCheckedAt: new Date(), openretroEntryId: uuid })
          .where(eq(blobs.sha256, b.sha256));
        out.enriched++;
      } catch (err) {
        // Deliberately does NOT stamp: an image fetch failure is usually
        // transient, and stamping would record it as decided forever.
        console.error(`openretro: enrichment failed for blob ${b.sha256}`, err);
      }
    }
  }
```

with, at the top of the file:

```ts
/** Blobs considered per enrichment pass. */
const ENRICH_BATCH = 50;
/**
 * Images fetched per sweep run, across all blobs. A first pass over a large
 * library therefore spreads over several nights instead of arriving at
 * openretro.org as a burst.
 */
const IMAGE_CAP_PER_RUN = 40;
```

and a helper that fetches an entry's front, title and screenshots via `ensureImage`, returning how many it fetched and accumulating `out.imagesStored` / `out.imageBytes`. Screenshots come from the parsed list held on the entry — store them in `openretro_images` as they are fetched, per Task 3 Step 1's note.

- [ ] **Step 2: Extend `scanStatus`**

Add the enrichment counts to the existing single-round-trip SQL, following the shape already there.

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/tosec-sweep.ts
git commit -m "Add enrichment as the sweeper's third phase"
```

---

### Task 7: Surface it — admin page, upload control, game page

**Files:**
- Create: `src/components/admin/openretro-upload.tsx`
- Modify: `src/app/(admin)/admin/scan/page.tsx`, `src/app/(app)/games/[id]/page.tsx`, `src/lib/queries.ts`

- [ ] **Step 1: The upload control**

`src/components/admin/openretro-upload.tsx` — a client component mirroring `dat-upload.tsx`: a file input (`accept=".sqlite"`), `await file.arrayBuffer()`, `POST` to `/api/admin/openretro` with `content-type: application/octet-stream`, a busy label, toast on success and failure, `router.refresh()` in a `finally`. Single file, not multiple — there is only ever one `Amiga.sqlite`. Read `dat-upload.tsx` and match its error handling, including the inner `try/catch` around `fetch` itself.

- [ ] **Step 2: Admin tiles**

Add enrichment tiles to `/admin/scan` beside the match tiles — `enriched`, `enrich-none`, `enrich-unchecked`, `openretro-entries`, `images-stored` — each with a `data-testid`, plus the stored image total in MB so the storage cost stays visible. Render the upload control next to the DAT upload.

- [ ] **Step 3: `getGame` returns the new fields**

In `src/lib/queries.ts`, extend `getGame`'s select with `developer`, `players`, `description`, `history`, `factsSource`, and join `openretroImages` (via `blobs.openretroEntryId` for any of the game's disks) to return `front`, `title` and ordered `screenshots`, each with its `storageKey` and `sourceUrl`.

- [ ] **Step 4: Render the game page**

In `src/app/(app)/games/[id]/page.tsx`: show the front cover, a screenshot strip, and a facts block (publisher, developer, year, players, languages, genre, chipset). Show `description`/`history` only when non-null — they stay empty until a Hall of Light increment. Add the outbound links (Hall of Light, MobyGames, Lemon, Wikipedia, longplay) as a small link row.

**Attribution:** render a line crediting OpenRetro and linking to the entry's page (`https://openretro.org/amiga/<slug>` when `slug` is set). The spec's §8 records that copying these images is redistribution of volunteer-contributed content — the credit is the cheapest part of behaving well.

Follow the existing page's style; amber text must use `--amber-text`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/components/admin/openretro-upload.tsx "src/app/(admin)/admin/scan/page.tsx" "src/app/(app)/games/[id]/page.tsx" src/lib/queries.ts
git commit -m "Surface enrichment: admin tiles, the sqlite upload, and the game page"
```

---

### Task 8: End-to-end tests

**Files:**
- Create: `e2e/openretro.spec.ts`

- [ ] **Step 1: Write the specs**

`e2e/openretro.spec.ts`. **No test may reach openretro.org** — seed `openretro_entries`, `openretro_disk_sha1` and `openretro_images` directly, and assert on what the catalog and page do with them.

Cover:

1. **A matched blob enriches its game.** Seed a disk with a known sha1, an entry, and a sha1 mapping; run `POST /api/admin/scan`; assert the game's `publisher`, `developer`, `genre` and `chipset` are set and `factsSource` is `'openretro'`.
2. **A human-edited game is not overwritten.** Same setup, but set the game's `metadataSource` to `'manual'` first; assert its publisher is unchanged after the sweep.
3. **Two entries for one sha1 is ambiguous.** Seed two mappings for the same sha1; assert `enrich_state = 'ambiguous'` and the game untouched.
4. **A sweep is never observable as an eject.** Pair a device (`pairDevice(page, request, …)` — it uses the page's **tenant** session, so it must run before `signInAsSuperAdmin`), set its desired state to the disk, run the scan, and assert `desiredDiskId`, `desiredSha256` and `desiredVersion` are unchanged and the disk row still exists by id. Assert the enrichment actually fired first, or the test passes on a no-op.
5. **The game page renders the enriched facts and the attribution link.**

Give every seeded entry a **distinct uuid** and clean up in `afterAll`.

- [ ] **Step 2: Run everything**

```bash
pnpm vitest run && pnpm build && pnpm e2e
```

Report the counts. The suite runs `workers: 1` and takes ~20 minutes.

- [ ] **Step 3: Commit**

```bash
git add e2e/openretro.spec.ts
git commit -m "Cover enrichment end to end, including the eject hazard"
```

---

### Task 9: Runbook and the real import

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-08-31-openretro-enrichment-design.md`

- [ ] **Step 1: Operator steps**

1. Run FS-UAE Launcher once and let it sync, producing `Amiga.sqlite`.
2. Upload it at `/admin/scan`.
3. Press **Run now** repeatedly until `enrich-unchecked` reaches 0. Image fetching is capped per run by design, so a first pass over a large library takes several runs or several nights.

- [ ] **Step 2: Import the operator's real file and measure**

Import the `Amiga.sqlite` at the repo root, run the sweeper to completion, and record in `HANDOFF.md`: how many of the operator's disks enriched, how many missed, how many images were stored and their total size.

**Compare the enrichment rate to TOSEC's measured 45%** and say plainly whether OpenRetro knows more or less of this library. That comparison is the honest reason to do or not do a Hall of Light increment next.

- [ ] **Step 3: Update the docs**

`HANDOFF.md` gains an "OpenRetro enrichment" section with the runbook, the measured rates, and the traps: the zlib-not-gzip framing, the BLOB-vs-string uuid, `?size=` versus the silently-ignored `?width=`, and that `hol_url` makes a Hall of Light increment an exact lookup.

Mark the spec delivered.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-08-31-openretro-enrichment-design.md
git commit -m "Record the OpenRetro enrichment as delivered, with the measured rate"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean.
- An enrichment sweep was observed **not** to change any device's desired state.
- A game with `metadataSource` outside `MACHINE_SOURCES` was observed to survive a sweep unchanged.
- The operator's real `Amiga.sqlite` imported, the sweeper drained, and the enrichment rate recorded in `HANDOFF.md` alongside TOSEC's 45%.
- Total stored image bytes recorded, so the storage cost is a known number rather than a surprise.
