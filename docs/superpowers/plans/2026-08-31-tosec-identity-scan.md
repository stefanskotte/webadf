# TOSEC Identity Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify every stored disk image by content hash against imported TOSEC DAT data, and correct the catalog's filename-derived titles from it.

**Architecture:** TOSEC entries and blob content hashes are **global** (no `orgId`) because identity is a property of bytes — one import and one hash serve every tenant. Hashes are computed server-side only: at ingest inside the read-back `verify()` already performs, and by a batched, resumable sweeper for the blobs that predate this work. Matched metadata is applied to per-tenant `games`/`disks` rows, and duplicate games are merged on `(sortTitle, year)` — **never by re-deriving ids**.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Components) · React 19.2 · Tailwind 4 · shadcn v4 (**Base UI, not Radix**) · Drizzle 0.45 · Postgres (Neon HTTP) · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-08-31-tosec-identity-scan-design.md`

## Global Constraints

- **Ids are NEVER re-derived.** Not `games.id`, not `disks.id`. `devices.desiredDiskId` is plain `text` with no foreign key and `readDesired` joins on it; a re-keyed disk makes that join return nothing, and "no disk desired" **is** eject in this protocol. A metadata scan must never be observable as an eject (disk-change spec §1 rule 1).
- **`blobs` is global and content-addressed.** It has no `orgId` and is shared across organizations. Hashes and TOSEC matches live there so a disk is identified once for every tenant. **Never delete a blob.**
- **`tosec_entries` is global too** — no `orgId`, same class as `blobs`.
- **No client ever supplies a content hash.** CRC32/MD5/SHA1 are computed server-side from stored bytes only (spec §7).
- **`db.transaction()` throws on this driver** — drizzle's neon-http raises *"No transactions support in neon-http driver"*. Use `db.batch()`, which neon wraps in one server-side transaction, exactly as `src/lib/admin-delete.ts` does. Batches are non-interactive: every read shaping one runs first.
- **`getDb().execute()` returns `{ rows }`** on neon-http, not an array. `.rows[0]`, never `const [row] =`.
- **Vitest never opens a database connection.** Pure logic only; anything touching Postgres is Playwright. Vitest has no `DATABASE_URL`.
- **Vitest cannot render async Server Components.** Pages and flows are Playwright.
- **Next 16:** `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — never import them. `cacheComponents` stays off.
- **shadcn v4 here is Base UI, not Radix.** Any Radix-era snippet is wrong.
- **`drizzle.config.ts` must keep `schemaFilter: ['public','auth']`.** Without it `db:push` silently skips a schema while printing "Changes applied."
- **Every `/api/admin/*` route calls `requireSuperAdmin()` itself.** The page guard is not the API guard.
- **`--accent-amber` (`#f5822e`) is fill-only** and fails WCAG AA as text. Amber text is `--amber-text` (`#a8560f`).
- Every e2e spec calls `test.afterAll(cleanupSeeded)` from `e2e/device-helpers.ts` and runs against the operator's **live** database.
- Run `pnpm vitest run`, `pnpm build` and `pnpm e2e` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/crc32.ts` | **Create.** Dependency-free CRC32. Pure. |
| `src/lib/crc32.test.ts` | **Create.** Vitest, known vectors. |
| `src/lib/tosec-dat.ts` | **Create.** Parse a DAT file's text into entry records. Pure — no DB, no fs. |
| `src/lib/tosec-dat.test.ts` | **Create.** Vitest over real DAT fragments. |
| `src/lib/tosec-match.ts` | **Create.** The matching cascade. Pure — takes hashes and candidate rows, returns a verdict. |
| `src/lib/tosec-match.test.ts` | **Create.** Vitest, including ambiguity and the CRC32-needs-size rule. |
| `src/db/schema/tosec.ts` | **Create.** `tosecEntries` table. |
| `src/db/schema/catalog.ts` | **Modify.** `blobs` gains hash + match columns. |
| `src/lib/content-hashes.ts` | **Create.** `contentHashes(bytes)` → all four digests. Used by ingest and sweeper. |
| `src/lib/tosec-import.ts` | **Create.** Persist parsed DAT entries (upsert, idempotent). |
| `src/lib/tosec-apply.ts` | **Create.** Apply a match to a tenant's catalog, and the `(sortTitle, year)` merge. The destructive one, its own file. |
| `src/lib/tosec-sweep.ts` | **Create.** The batched, resumable sweeper: hash phase then match phase. |
| `src/app/api/ingest/complete/route.ts` | **Modify.** Compute the three extra hashes inside `verify()`'s existing read-back. |
| `src/app/api/cron/scan/route.ts` | **Create.** `GET`, Bearer `CRON_SECRET`. |
| `src/app/api/admin/tosec/route.ts` | **Create.** `POST` DAT upload/import. |
| `src/app/api/admin/scan/route.ts` | **Create.** `POST` run one sweep batch now. |
| `src/app/(admin)/admin/scan/page.tsx` | **Create.** Status, miss rate, upload, Run now. |
| `src/components/admin/dat-upload.tsx` | **Create.** Client. |
| `src/components/admin/run-scan-button.tsx` | **Create.** Client. |
| `src/components/admin/admin-nav.tsx` | **Modify.** Add the Scan entry. |
| `vercel.ts` | **Create.** The `crons` declaration. Repo has no Vercel config today. |
| `e2e/tosec-helpers.ts` | **Create.** Seed `tosec_entries` directly for tests. |
| `e2e/tosec-scan.spec.ts` | **Create.** Apply, merge, and the eject-hazard test. |
| `e2e/admin-scan.spec.ts` | **Create.** Guard + upload + Run now. |

---

### Task 1: CRC32

**Files:**
- Create: `src/lib/crc32.ts`, `src/lib/crc32.test.ts`

**Interfaces:**
- Produces: `export function crc32(bytes: Uint8Array): string` — 8 lowercase hex chars, zero-padded.

CRC32 is not in `node:crypto`. Written by hand and dependency-free, in the same spirit as `adfmfm`. TOSEC DATs write CRC as 8 hex digits, so the return type is the padded hex string, not a number — that is what gets compared and stored.

- [ ] **Step 1: Write the failing test**

`src/lib/crc32.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { crc32 } from './crc32';

const enc = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(enc(''))).toBe('00000000');
    expect(crc32(enc('a'))).toBe('e8b7be43');
    expect(crc32(enc('abc'))).toBe('352441c2');
    expect(crc32(enc('123456789'))).toBe('cbf43926');
  });

  it('zero-pads a small result to 8 hex chars', () => {
    // The point of returning a string: TOSEC writes crc as 8 hex digits, and
    // a numeric 0 formatted with toString(16) would be "0", never matching.
    expect(crc32(enc('')).length).toBe(8);
  });

  it('is lowercase, so comparisons need no normalising at the call site', () => {
    expect(crc32(enc('abc'))).toBe(crc32(enc('abc')).toLowerCase());
  });

  it('handles bytes above 0x7f', () => {
    expect(crc32(new Uint8Array([0x00, 0xff, 0x80, 0x7f]))).toMatch(/^[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/crc32.test.ts`
Expected: FAIL — cannot resolve `./crc32`.

- [ ] **Step 3: Implement**

`src/lib/crc32.ts`:

```ts
// CRC32 (IEEE 802.3, reflected, poly 0xEDB88320) -- the variant TOSEC DAT
// files use. node:crypto has no CRC32, and this is ~20 lines, so it is
// written here rather than adding a dependency, the same reasoning that
// keeps src/lib/adfmfm dependency-free.

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 8 lowercase hex characters, zero-padded. */
export function crc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  // >>> 0 forces the unsigned reading before formatting; without it a value
  // with the high bit set formats as a negative number.
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/crc32.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crc32.ts src/lib/crc32.test.ts
git commit -m "Add a dependency-free CRC32 for TOSEC matching"
```

---

### Task 2: The DAT parser

**Files:**
- Create: `src/lib/tosec-dat.ts`, `src/lib/tosec-dat.test.ts`

**Interfaces:**
- Consumes: `parseTosecName`, `makeSortTitle` from `@/lib/tosec`.
- Produces:

```ts
export interface DatEntry {
  gameName: string; romName: string; sizeBytes: number;
  crc32: string | null; md5: string | null; sha1: string | null;
  title: string; sortTitle: string; year: number | null;
  publisher: string | null; diskNo: number | null; diskCount: number | null;
}
export interface DatFile { setName: string; setVersion: string | null; entries: DatEntry[] }
export function parseDat(text: string): DatFile;
```

TOSEC ships both ClrMamePro and Logiqx-XML DATs. `parseDat` detects which by looking for a leading `<?xml`. Hashes are lowercased on the way in so nothing downstream normalises.

- [ ] **Step 1: Write the failing test**

`src/lib/tosec-dat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseDat } from './tosec-dat';

const CMP = `clrmamepro (
	name "Commodore Amiga - Games - [ADF]"
	description "Commodore Amiga - Games - [ADF] (TOSEC-v2024-01-01)"
	version 2024-01-01
)

game (
	name "State of the Art (1992)(Spaceballs)(PD)"
	description "State of the Art (1992)(Spaceballs)(PD)"
	rom ( name "State of the Art (1992)(Spaceballs)(PD).adf" size 901120 crc 1A2B3C4D md5 D41D8CD98F00B204E9800998ECF8427E sha1 DA39A3EE5E6B4B0D3255BFEF95601890AFD80709 )
)

game (
	name "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3)"
	description "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3)"
	rom ( name "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3).adf" size 901120 crc DEADBEEF )
)
`;

const XML = `<?xml version="1.0"?>
<datafile>
  <header><name>Commodore Amiga - Games - [ADF]</name><version>2024-01-01</version></header>
  <game name="State of the Art (1992)(Spaceballs)(PD)">
    <rom name="State of the Art (1992)(Spaceballs)(PD).adf" size="901120" crc="1A2B3C4D" md5="D41D8CD98F00B204E9800998ECF8427E" sha1="DA39A3EE5E6B4B0D3255BFEF95601890AFD80709"/>
  </game>
</datafile>`;

describe('parseDat (ClrMamePro)', () => {
  it('reads the set name and version from the header', () => {
    const dat = parseDat(CMP);
    expect(dat.setName).toBe('Commodore Amiga - Games - [ADF]');
    expect(dat.setVersion).toBe('2024-01-01');
  });

  it('reads every game, not just the first', () => {
    expect(parseDat(CMP).entries).toHaveLength(2);
  });

  it('lowercases hashes so nothing downstream has to normalise', () => {
    const e = parseDat(CMP).entries[0];
    expect(e.crc32).toBe('1a2b3c4d');
    expect(e.md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(e.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('leaves absent hashes null rather than empty strings', () => {
    // The second entry has crc only. A '' here would match a blob whose md5
    // was also '' -- null cannot be compared equal by accident.
    const e = parseDat(CMP).entries[1];
    expect(e.crc32).toBe('deadbeef');
    expect(e.md5).toBeNull();
    expect(e.sha1).toBeNull();
  });

  it('parses the game name through parseTosecName', () => {
    const e = parseDat(CMP).entries[0];
    expect(e.title).toBe('State of the Art');
    expect(e.year).toBe(1992);
    expect(e.publisher).toBe('Spaceballs');
    expect(e.sortTitle).toBe('state of the art');
  });

  it('carries the disk clause through', () => {
    const e = parseDat(CMP).entries[1];
    expect(e.title).toBe('Turrican II');
    expect(e.diskNo).toBe(2);
    expect(e.diskCount).toBe(3);
  });

  it('records the size, which the crc32 fallback depends on', () => {
    expect(parseDat(CMP).entries[0].sizeBytes).toBe(901120);
  });
});

describe('parseDat (Logiqx XML)', () => {
  it('produces the same entry from the XML form', () => {
    const x = parseDat(XML).entries[0];
    const c = parseDat(CMP).entries[0];
    expect(x.romName).toBe(c.romName);
    expect(x.sha1).toBe(c.sha1);
    expect(x.title).toBe(c.title);
    expect(x.year).toBe(c.year);
  });

  it('reads the header out of <header>', () => {
    expect(parseDat(XML).setName).toBe('Commodore Amiga - Games - [ADF]');
    expect(parseDat(XML).setVersion).toBe('2024-01-01');
  });
});

describe('parseDat robustness', () => {
  it('returns no entries for empty input rather than throwing', () => {
    expect(parseDat('').entries).toEqual([]);
  });

  it('skips a game with no rom line', () => {
    expect(parseDat('game (\n\tname "Nothing"\n)\n').entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/tosec-dat.test.ts`
Expected: FAIL — cannot resolve `./tosec-dat`.

- [ ] **Step 3: Implement**

`src/lib/tosec-dat.ts`:

```ts
// Parses a TOSEC DAT into entry records. Pure: no database, no filesystem,
// no network -- so it is unit-testable, which matters because this is where
// a malformed set would otherwise become bad metadata for every tenant.
//
// TOSEC publishes both ClrMamePro and Logiqx-XML DATs and people download
// whichever they find, so both are accepted rather than making the operator
// care which one they got.

import { parseTosecName } from '@/lib/tosec';

export interface DatEntry {
  gameName: string; romName: string; sizeBytes: number;
  crc32: string | null; md5: string | null; sha1: string | null;
  title: string; sortTitle: string; year: number | null;
  publisher: string | null; diskNo: number | null; diskCount: number | null;
}

export interface DatFile { setName: string; setVersion: string | null; entries: DatEntry[] }

/** Absent stays null. '' would compare equal to another '' and match by accident. */
function hash(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
}

function toEntry(gameName: string, romName: string, sizeBytes: number,
                 c: string | null, m: string | null, s: string | null): DatEntry {
  // The game name is a canonical TOSEC string -- which is the input
  // parseTosecName was written for, unlike the user filenames it normally sees.
  const p = parseTosecName(gameName.endsWith('.adf') ? gameName : `${gameName}.adf`);
  return {
    gameName, romName, sizeBytes,
    crc32: c, md5: m, sha1: s,
    title: p.title, sortTitle: p.sortTitle, year: p.year,
    publisher: p.publisher, diskNo: p.diskNo, diskCount: p.diskCount,
  };
}

function parseXml(text: string): DatFile {
  const setName = text.match(/<name>([^<]*)<\/name>/)?.[1]?.trim() ?? 'unknown';
  const setVersion = text.match(/<version>([^<]*)<\/version>/)?.[1]?.trim() ?? null;
  const entries: DatEntry[] = [];

  for (const g of text.matchAll(/<game\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/game>/g)) {
    const gameName = g[1];
    const rom = g[2].match(/<rom\s+([^>]*)\/?>/);
    if (!rom) continue;
    const attrs = rom[1];
    const attr = (k: string) => attrs.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? null;
    const name = attr('name');
    if (!name) continue;
    entries.push(toEntry(gameName, name, Number(attr('size') ?? 0),
      hash(attr('crc')), hash(attr('md5')), hash(attr('sha1'))));
  }
  return { setName, setVersion, entries };
}

function parseCmp(text: string): DatFile {
  const header = text.match(/clrmamepro\s*\(([\s\S]*?)\)/)?.[1] ?? '';
  const setName = header.match(/name\s+"([^"]*)"/)?.[1] ?? 'unknown';
  const setVersion = header.match(/version\s+(\S+)/)?.[1]?.replace(/"/g, '') ?? null;
  const entries: DatEntry[] = [];

  for (const g of text.matchAll(/\bgame\s*\(([\s\S]*?)\n\)/g)) {
    const body = g[1];
    const gameName = body.match(/\bname\s+"([^"]*)"/)?.[1];
    const rom = body.match(/\brom\s*\(([^)]*)\)/)?.[1];
    if (!gameName || !rom) continue;
    const romName = rom.match(/\bname\s+"([^"]*)"/)?.[1];
    if (!romName) continue;
    const field = (k: string) => rom.match(new RegExp(`\\b${k}\\s+([0-9A-Fa-f]+)`))?.[1] ?? null;
    entries.push(toEntry(gameName, romName, Number(rom.match(/\bsize\s+(\d+)/)?.[1] ?? 0),
      hash(field('crc')), hash(field('md5')), hash(field('sha1'))));
  }
  return { setName, setVersion, entries };
}

export function parseDat(text: string): DatFile {
  if (text.trimStart().startsWith('<?xml') || text.includes('<datafile')) return parseXml(text);
  return parseCmp(text);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/tosec-dat.test.ts`
Expected: PASS. If the `parseTosecName` assertions fail, **do not fork the parser** — a divergence is a bug in the shared parser (spec §3.1). Report it rather than special-casing here.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tosec-dat.ts src/lib/tosec-dat.test.ts
git commit -m "Parse TOSEC DAT files in both ClrMamePro and XML forms"
```

---

### Task 3: The matching cascade

**Files:**
- Create: `src/lib/tosec-match.ts`, `src/lib/tosec-match.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BlobHashes { crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }
export interface Candidate { id: string; crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }
export type MatchVerdict =
  | { state: 'matched'; entryId: string }
  | { state: 'none' }
  | { state: 'ambiguous'; entryIds: string[] };
export function matchBlob(blob: BlobHashes, candidates: Candidate[]): MatchVerdict;
```

Pure, so the whole decision is Vitest-testable without a database. The caller supplies candidates already narrowed by SQL.

- [ ] **Step 1: Write the failing test**

`src/lib/tosec-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchBlob, type Candidate } from './tosec-match';

const SIZE = 901120;
const A: Candidate = { id: 'a', crc32: 'aaaaaaaa', md5: 'a'.repeat(32), sha1: 'a'.repeat(40), sizeBytes: SIZE };
const B: Candidate = { id: 'b', crc32: 'aaaaaaaa', md5: 'b'.repeat(32), sha1: 'b'.repeat(40), sizeBytes: SIZE };

describe('matchBlob', () => {
  it('matches on sha1 when present', () => {
    const v = matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, [A, B]);
    expect(v).toEqual({ state: 'matched', entryId: 'a' });
  });

  it('prefers sha1 over a crc32 that points elsewhere', () => {
    // Both candidates share a crc32; only sha1 disambiguates. A cascade that
    // checked crc32 first would call this ambiguous and give up.
    const v = matchBlob({ crc32: 'aaaaaaaa', md5: null, sha1: 'b'.repeat(40), sizeBytes: SIZE }, [A, B]);
    expect(v).toEqual({ state: 'matched', entryId: 'b' });
  });

  it('falls back to md5 when sha1 is absent on both sides', () => {
    const noSha: Candidate[] = [{ ...A, sha1: null }, { ...B, sha1: null }];
    const v = matchBlob({ crc32: null, md5: 'b'.repeat(32), sha1: null, sizeBytes: SIZE }, noSha);
    expect(v).toEqual({ state: 'matched', entryId: 'b' });
  });

  it('uses crc32 ONLY together with size', () => {
    const only: Candidate[] = [{ id: 'c', crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: SIZE }];
    expect(matchBlob({ crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: SIZE }, only))
      .toEqual({ state: 'matched', entryId: 'c' });
    // Same crc32, different size -- a 32-bit checksum collides, so this must NOT match.
    expect(matchBlob({ crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: 12345 }, only))
      .toEqual({ state: 'none' });
  });

  it('reports ambiguity instead of picking one', () => {
    const twins: Candidate[] = [A, { ...B, sha1: 'a'.repeat(40) }];
    const v = matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, twins);
    expect(v.state).toBe('ambiguous');
    expect((v as { entryIds: string[] }).entryIds.sort()).toEqual(['a', 'b']);
  });

  it('is none when nothing matches', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: 'f'.repeat(40), sizeBytes: SIZE }, [A, B]))
      .toEqual({ state: 'none' });
  });

  it('is none when the blob has no hashes at all', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: null, sizeBytes: SIZE }, [A, B]))
      .toEqual({ state: 'none' });
  });

  it('is none with no candidates', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, []))
      .toEqual({ state: 'none' });
  });

  it('never matches a null against a null', () => {
    // Two entries with no sha1 must not "both match" a blob with no sha1.
    const nulls: Candidate[] = [{ id: 'x', crc32: null, md5: null, sha1: null, sizeBytes: SIZE }];
    expect(matchBlob({ crc32: null, md5: null, sha1: null, sizeBytes: SIZE }, nulls))
      .toEqual({ state: 'none' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/tosec-match.test.ts`
Expected: FAIL — cannot resolve `./tosec-match`.

- [ ] **Step 3: Implement**

`src/lib/tosec-match.ts`:

```ts
// The matching decision, isolated from the database so every branch is
// unit-testable. The caller narrows candidates in SQL and passes them here.

export interface BlobHashes { crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }
export interface Candidate { id: string; crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }

export type MatchVerdict =
  | { state: 'matched'; entryId: string }
  | { state: 'none' }
  | { state: 'ambiguous'; entryIds: string[] };

/**
 * Strongest hash first. A tier is only consulted when the blob actually has
 * that hash, and a null NEVER equals a null -- two entries missing a sha1
 * must not both "match" a blob missing one.
 *
 * crc32 is a 32-bit checksum and collides, so it is only ever used together
 * with the exact size, and never preferred over a stronger hash that is
 * present on both sides.
 */
export function matchBlob(blob: BlobHashes, candidates: Candidate[]): MatchVerdict {
  const tiers: Array<(c: Candidate) => boolean> = [];
  if (blob.sha1) tiers.push((c) => c.sha1 !== null && c.sha1 === blob.sha1);
  if (blob.md5) tiers.push((c) => c.md5 !== null && c.md5 === blob.md5);
  if (blob.crc32) {
    tiers.push((c) => c.crc32 !== null && c.crc32 === blob.crc32 && c.sizeBytes === blob.sizeBytes);
  }

  for (const tier of tiers) {
    const hits = candidates.filter(tier);
    if (hits.length === 1) return { state: 'matched', entryId: hits[0].id };
    // Ambiguity stops the cascade rather than falling through to a weaker
    // hash: a weaker tier cannot resolve what a stronger one could not.
    if (hits.length > 1) return { state: 'ambiguous', entryIds: hits.map((h) => h.id) };
  }
  return { state: 'none' };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/tosec-match.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tosec-match.ts src/lib/tosec-match.test.ts
git commit -m "Add the TOSEC matching cascade, hash-strongest-first"
```

---

### Task 4: Schema — `tosec_entries` and the `blobs` columns

**Files:**
- Create: `src/db/schema/tosec.ts`
- Modify: `src/db/schema/catalog.ts`, `src/db/index.ts`

**Interfaces:**
- Produces: `tosecEntries` table; `blobs.crc32`, `.md5`, `.sha1`, `.hashedAt`, `.tosecEntryId`, `.matchState`, `.matchCheckedAt`.

- [ ] **Step 1: Create the table**

`src/db/schema/tosec.ts`:

```ts
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * GLOBAL, not per-tenant -- deliberately the same class as `blobs`. TOSEC
 * identity is a property of bytes, so one import serves every organization
 * and two tenants can never disagree about what the same bytes are.
 */
export const tosecEntries = pgTable('tosec_entries', {
  // Derived from (setName, romName) so re-importing the same set updates
  // rows instead of duplicating them.
  id: text('id').primaryKey(),
  setName: text('set_name').notNull(),
  setVersion: text('set_version'),
  gameName: text('game_name').notNull(),
  romName: text('rom_name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  // Lowercase hex, or null when the DAT omitted it. Never '' -- see
  // tosec-dat.ts's hash(): an empty string would compare equal by accident.
  crc32: text('crc32'),
  md5: text('md5'),
  sha1: text('sha1'),
  // Parsed from gameName by parseTosecName at import time.
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  publisher: text('publisher'),
  diskNo: integer('disk_no'),
  diskCount: integer('disk_count'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tosec_sha1_idx').on(t.sha1),
  index('tosec_md5_idx').on(t.md5),
  index('tosec_crc_size_idx').on(t.crc32, t.sizeBytes),
]);
```

- [ ] **Step 2: Add the blob columns**

In `src/db/schema/catalog.ts`, extend the `blobs` table definition (keep every existing column):

```ts
  // Content hashes beyond sha256, for TOSEC matching. Computed SERVER-SIDE
  // only -- at ingest inside verify()'s existing read-back, or by the
  // sweeper. No client ever supplies these (design §7).
  crc32: text('crc32'),
  md5: text('md5'),
  sha1: text('sha1'),
  hashedAt: timestamp('hashed_at', { withTimezone: true }),

  // The TOSEC identity of these bytes. Global on purpose: one match serves
  // every tenant holding this sha256.
  tosecEntryId: text('tosec_entry_id'),
  // 'matched' | 'none' | 'ambiguous'. NOT inferable from tosecEntryId alone:
  // "considered and found absent" and "not yet considered" are different
  // facts, and telling them apart is what makes the miss rate measurable.
  matchState: text('match_state'),
  matchCheckedAt: timestamp('match_checked_at', { withTimezone: true }),
```

Add to the table's index list:

```ts
  index('blobs_hashed_at_idx').on(t.hashedAt),
  index('blobs_match_checked_idx').on(t.matchCheckedAt),
```

**No foreign key on `tosecEntryId`.** A DAT re-import may remove an entry, and a dangling reference must degrade to "unmatched", never block the import.

- [ ] **Step 3: Register the schema**

In `src/db/index.ts`, import and spread the new module alongside the others:

```ts
import * as tosec from './schema/tosec';
// ...
const schema = { ...catalog, ...authTables, ...devices, ...tosec };
```

- [ ] **Step 4: Push the schema**

Run: `pnpm db:push`
Expected: the new table and columns are created. **Confirm the output names `tosec_entries` and the `blobs` columns** — `drizzle.config.ts`'s `schemaFilter: ['public','auth']` must stay, or push silently skips a schema while printing "Changes applied."

- [ ] **Step 5: Verify it compiles and commit**

```bash
pnpm vitest run && pnpm build
git add src/db/schema/tosec.ts src/db/schema/catalog.ts src/db/index.ts
git commit -m "Add tosec_entries and the blobs content-hash columns"
```

---

### Task 5: Content hashing, and wiring it into ingest

**Files:**
- Create: `src/lib/content-hashes.ts`, `src/lib/content-hashes.test.ts`
- Modify: `src/app/api/ingest/complete/route.ts`

**Interfaces:**
- Consumes: `crc32` (Task 1).
- Produces: `export function contentHashes(bytes: Uint8Array): { sha256: string; crc32: string; md5: string; sha1: string }`

- [ ] **Step 1: Write the failing test**

`src/lib/content-hashes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { contentHashes } from './content-hashes';

describe('contentHashes', () => {
  it('computes all four digests of the empty input', () => {
    const h = contentHashes(new Uint8Array(0));
    expect(h.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(h.md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(h.crc32).toBe('00000000');
  });

  it('returns lowercase hex for every digest', () => {
    const h = contentHashes(new TextEncoder().encode('abc'));
    for (const v of [h.sha256, h.sha1, h.md5, h.crc32]) expect(v).toMatch(/^[0-9a-f]+$/);
  });

  it('agrees with the known sha256 the ingest path already enforces', () => {
    // Same value ingest/complete's verify() computes, so a mismatch here
    // would mean this helper cannot be trusted to replace that call.
    expect(contentHashes(new TextEncoder().encode('abc')).sha256)
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/lib/content-hashes.test.ts`
Expected: FAIL — cannot resolve `./content-hashes`.

- [ ] **Step 3: Implement**

`src/lib/content-hashes.ts`:

```ts
import { createHash } from 'node:crypto';
import { crc32 } from '@/lib/crc32';

/**
 * Every digest TOSEC matching needs, from one pass over bytes already in
 * memory. Server-side only: no client ever supplies these (design §7),
 * because writing an unverified hash to the shared `blobs` row would let one
 * uploader mislabel a disk for every tenant holding the same bytes.
 */
export function contentHashes(bytes: Uint8Array) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    md5: createHash('md5').update(bytes).digest('hex'),
    crc32: crc32(bytes),
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/lib/content-hashes.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use it in `verify()`**

In `src/app/api/ingest/complete/route.ts`, the `Verdict` type gains the hashes, and `verify()` computes them from the bytes it **already reads**. Change the `Verdict` type to:

```ts
type Verdict =
  | { ok: true; sizeBytes: number; gzipSizeBytes: number | null;
      // Present only on the first-registration path, which is the only
      // branch that reads the bytes. A dedupe hit skips the read-back by
      // design and its blob already carries hashes from that first write.
      hashes: { crc32: string; md5: string; sha1: string } | null }
  | { ok: false; reason: 'not-stored' | 'size-mismatch' | 'digest-mismatch' };
```

In the `alreadyRegistered` early return, add `hashes: null`. In the final return, replace the standalone sha256 computation with `contentHashes` and return the rest:

```ts
  const bytes = await diskStore.read(sha256);
  // One pass over bytes that are already in memory. This is the only moment
  // they ever are (see the comment on verify()), so it is the only free
  // opportunity to record the other three digests.
  const h = contentHashes(bytes);
  if (h.sha256 !== sha256) {
    await release(sha256);
    return { ok: false, reason: 'digest-mismatch' };
  }
  if (bytes.byteLength !== claimedSize) return { ok: false, reason: 'size-mismatch' };

  return {
    ok: true,
    sizeBytes: bytes.byteLength,
    gzipSizeBytes: gzipSync(bytes).byteLength,
    hashes: { crc32: h.crc32, md5: h.md5, sha1: h.sha1 },
  };
```

Then, where the `blobs` row is inserted for a newly-verified file, include the hashes and `hashedAt`. Find the `db.insert(blobs)` call and add to its values, for rows whose verdict carried hashes:

```ts
      crc32: v.hashes?.crc32 ?? null,
      md5: v.hashes?.md5 ?? null,
      sha1: v.hashes?.sha1 ?? null,
      hashedAt: v.hashes ? new Date() : null,
```

Add the import at the top: `import { contentHashes } from '@/lib/content-hashes';`. The now-unused `createHash` import may need removing if nothing else uses it — check before deleting.

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm vitest run && pnpm build && pnpm e2e e2e/ingest-api.spec.ts`
Expected: all green. The ingest API suite is the one that exercises digest-mismatch and size-mismatch, so it is the specific proof that reshaping `verify()` did not weaken content addressing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/content-hashes.ts src/lib/content-hashes.test.ts src/app/api/ingest/complete/route.ts
git commit -m "Compute every TOSEC hash in the read-back ingest already performs"
```

---

### Task 6: DAT import

**Files:**
- Create: `src/lib/tosec-import.ts`, `src/app/api/admin/tosec/route.ts`

**Interfaces:**
- Consumes: `parseDat` (Task 2), `tosecEntries` (Task 4), `stableId` from `@/lib/ingest`, `requireSuperAdmin`.
- Produces: `export async function importDat(text: string): Promise<{ setName: string; setVersion: string | null; imported: number }>`

- [ ] **Step 1: Implement the importer**

`src/lib/tosec-import.ts`:

```ts
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
```

- [ ] **Step 2: Add the route**

`src/app/api/admin/tosec/route.ts`:

```ts
import { requireSuperAdmin } from '@/lib/superadmin';
import { importDat } from '@/lib/tosec-import';

// A large DAT is a few MB of text and parsing is CPU-bound; give it room.
export const maxDuration = 300;

/**
 * Import a TOSEC DAT. requireSuperAdmin() is called HERE, not merely in the
 * (admin) layout: a page render and a later fetch are separate requests.
 *
 * The body is the DAT's raw text. Both ClrMamePro and XML forms are accepted;
 * parseDat detects which.
 */
export async function POST(request: Request) {
  await requireSuperAdmin();
  const text = await request.text();
  if (text.trim().length === 0) {
    return Response.json({ error: 'empty' }, { status: 400 });
  }
  const result = await importDat(text);
  if (result.imported === 0) {
    // Parsed fine but produced nothing -- almost certainly not a DAT. Say so
    // rather than reporting a cheerful zero.
    return Response.json({ error: 'no_entries', ...result }, { status: 400 });
  }
  return Response.json(result);
}
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/tosec-import.ts src/app/api/admin/tosec/route.ts
git commit -m "Import TOSEC DAT files through the admin plane"
```

---

### Task 7: Applying a match, and the merge

**Files:**
- Create: `src/lib/tosec-apply.ts`

**Interfaces:**
- Consumes: `tosecEntries`, `games`, `disks`, `devices`, `stableId`.
- Produces:

```ts
export interface ApplyResult { gamesUpdated: number; disksUpdated: number; gamesMerged: number }
export async function applyMatch(sha256: string, entryId: string): Promise<ApplyResult>;
```

**This is the destructive one and has its own file for that reason.** Read the Global Constraints again before writing it: ids are never re-derived.

- [ ] **Step 1: Implement**

`src/lib/tosec-apply.ts`:

```ts
// Applies a TOSEC identity to every tenant's catalog rows for one sha256.
//
// IDS ARE NEVER RE-DERIVED. games.id feeds stableId('disk', gameId, sha256),
// so re-keying a game would re-key its disks -- and devices.desiredDiskId is
// plain text with no foreign key, joined by readDesired. A dangling
// desiredDiskId makes that join return nothing, and "no disk desired" is not
// an error in this protocol, it IS eject. Re-keying here would silently eject
// disks from real hardware, which disk-change spec section 1 rule 1 forbids.
//
// Duplicates are therefore resolved by CONTENT: two games in one org with the
// same (sortTitle, year) are the same game, and are merged.

import { and, eq, isNull, ne } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { tosecEntries } from '@/db/schema/tosec';

export interface ApplyResult { gamesUpdated: number; disksUpdated: number; gamesMerged: number }

export async function applyMatch(sha256: string, entryId: string): Promise<ApplyResult> {
  const db = getDb();

  const entryRows = await db.select().from(tosecEntries).where(eq(tosecEntries.id, entryId)).limit(1);
  const entry = entryRows[0];
  if (!entry) return { gamesUpdated: 0, disksUpdated: 0, gamesMerged: 0 };

  // Every disk holding these bytes, in every organization.
  const affected = await db
    .select({ diskId: disks.id, gameId: disks.gameId, orgId: disks.orgId })
    .from(disks)
    .where(eq(disks.sha256, sha256));
  if (affected.length === 0) return { gamesUpdated: 0, disksUpdated: 0, gamesMerged: 0 };

  const stmts: BatchItem<'pg'>[] = [];
  let disksUpdated = 0;
  let gamesUpdated = 0;
  let gamesMerged = 0;

  for (const row of affected) {
    // Disk level: the TOSEC rom name and disk number are authoritative.
    stmts.push(db.update(disks).set({
      tosecName: entry.romName,
      ...(entry.diskNo === null ? {} : { diskNo: entry.diskNo }),
    }).where(eq(disks.id, row.diskId)));
    disksUpdated++;

    // Game level: only over filename-derived metadata. A human edit is never
    // overwritten -- nothing writes such a value today, but the rule exists
    // before the first edit UI can forget it.
    stmts.push(db.update(games).set({
      title: entry.title, sortTitle: entry.sortTitle,
      year: entry.year, publisher: entry.publisher,
      metadataSource: 'tosec',
    }).where(and(eq(games.id, row.gameId), eq(games.metadataSource, 'filename'))));
    gamesUpdated++;
  }

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);

  // Merge pass, per affected organization. Done AFTER the renames above, so
  // rows that have just become duplicates are visible as such.
  for (const orgId of [...new Set(affected.map((a) => a.orgId))]) {
    gamesMerged += await mergeDuplicates(orgId, entry.sortTitle, entry.year);
  }

  return { gamesUpdated, disksUpdated, gamesMerged };
}

/**
 * Collapse every games row in one org sharing (sortTitle, year) into one.
 *
 * The survivor keeps its id, so no disk moves keys -- only disks.gameId
 * changes. devices.desiredGameId / mountedGameId are repointed in the same
 * batch, because those columns have no foreign key and would otherwise dangle
 * once the absorbed row is deleted. desiredDiskId is deliberately NOT touched:
 * disks keep their ids, so no device's desired state moves and no sweep can
 * be observed as an eject.
 */
async function mergeDuplicates(orgId: string, sortTitle: string, year: number | null): Promise<number> {
  const db = getDb();

  const dupes = await db
    .select({ id: games.id, createdAt: games.createdAt })
    .from(games)
    .where(and(
      eq(games.orgId, orgId),
      eq(games.sortTitle, sortTitle),
      year === null ? isNull(games.year) : eq(games.year, year),
    ))
    .orderBy(games.createdAt);

  if (dupes.length < 2) return 0;

  const survivor = dupes[0].id;
  const absorbed = dupes.slice(1).map((d) => d.id);

  const stmts: BatchItem<'pg'>[] = [];
  for (const gone of absorbed) {
    stmts.push(db.update(disks).set({ gameId: survivor }).where(eq(disks.gameId, gone)));
    stmts.push(db.update(devices).set({ desiredGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.desiredGameId, gone))));
    stmts.push(db.update(devices).set({ mountedGameId: survivor })
      .where(and(eq(devices.orgId, orgId), eq(devices.mountedGameId, gone))));
    stmts.push(db.delete(games).where(and(eq(games.id, gone), ne(games.id, survivor))));
  }
  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return absorbed.length;
}
```

- [ ] **Step 2: Verify it compiles and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/tosec-apply.ts
git commit -m "Apply TOSEC identity to the catalog, merging duplicates by content"
```

---

### Task 8: The sweeper

**Files:**
- Create: `src/lib/tosec-sweep.ts`

**Interfaces:**
- Consumes: `contentHashes`, `matchBlob`, `applyMatch`, `diskStore`.
- Produces:

```ts
export interface SweepResult { hashed: number; matched: number; none: number; ambiguous: number; done: boolean }
export async function sweep(budgetMs?: number): Promise<SweepResult>;
export interface ScanStatus { blobs: number; hashed: number; matched: number; none: number; ambiguous: number; unchecked: number; tosecEntries: number; sets: Array<{ setName: string; setVersion: string | null; entries: number }> }
export async function scanStatus(): Promise<ScanStatus>;
```

- [ ] **Step 1: Implement**

`src/lib/tosec-sweep.ts`:

```ts
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { matchBlob, type Candidate } from '@/lib/tosec-match';
import { applyMatch } from '@/lib/tosec-apply';

/** Stop well inside the 300 s function limit rather than being killed mid-write. */
const DEFAULT_BUDGET_MS = 240_000;
/** Blobs read per pass. Each read pulls ~880 KB. */
const HASH_BATCH = 25;
/** Blobs matched per pass. No blob reads here, so this can be larger. */
const MATCH_BATCH = 200;

export interface SweepResult { hashed: number; matched: number; none: number; ambiguous: number; done: boolean }

/**
 * One bounded, resumable pass. Safe to kill and re-run: the cursors are
 * `hashed_at is null` and `match_checked_at is null`, so nothing is processed
 * twice and nothing is skipped.
 *
 * Hashing runs first -- matching a blob with no hashes would only record a
 * spurious 'none'.
 */
export async function sweep(budgetMs: number = DEFAULT_BUDGET_MS): Promise<SweepResult> {
  const db = getDb();
  const started = Date.now();
  const out: SweepResult = { hashed: 0, matched: 0, none: 0, ambiguous: 0, done: false };
  const spent = () => Date.now() - started;

  // Phase 1 -- hash.
  while (spent() < budgetMs) {
    const todo = await db.select({ sha256: blobs.sha256 }).from(blobs)
      .where(isNull(blobs.hashedAt)).limit(HASH_BATCH);
    if (todo.length === 0) break;

    for (const b of todo) {
      if (spent() >= budgetMs) break;
      try {
        const bytes = await diskStore.read(b.sha256);
        const h = contentHashes(bytes);
        await db.update(blobs)
          .set({ crc32: h.crc32, md5: h.md5, sha1: h.sha1, hashedAt: new Date() })
          .where(eq(blobs.sha256, b.sha256));
        out.hashed++;
      } catch {
        // Bytes missing from the store, or unreadable. Stamp hashedAt so the
        // sweeper does not spin on it forever; the hashes stay null, so it
        // will simply never match. A blob row without bytes is a separate
        // problem and not this job's to fix.
        await db.update(blobs).set({ hashedAt: new Date() }).where(eq(blobs.sha256, b.sha256));
      }
    }
  }

  // Phase 2 -- match.
  while (spent() < budgetMs) {
    const todo = await db.select({
      sha256: blobs.sha256, crc32: blobs.crc32, md5: blobs.md5,
      sha1: blobs.sha1, sizeBytes: blobs.sizeBytes,
    }).from(blobs)
      .where(and(isNull(blobs.matchCheckedAt), sql`${blobs.hashedAt} is not null`))
      .limit(MATCH_BATCH);
    if (todo.length === 0) { out.done = true; break; }

    for (const b of todo) {
      if (spent() >= budgetMs) break;

      // A blob with NO hashes (its bytes were unreadable, so phase 1 stamped
      // hashedAt and left the hashes null) must short-circuit. Otherwise every
      // branch of the or() below is undefined, drizzle emits .where(undefined),
      // and the query loads the ENTIRE tosec_entries table into memory to
      // reach the same 'none' the matcher would return anyway.
      if (!b.sha1 && !b.md5 && !b.crc32) {
        await db.update(blobs)
          .set({ matchState: 'none', matchCheckedAt: new Date(), tosecEntryId: null })
          .where(eq(blobs.sha256, b.sha256));
        out.none++;
        continue;
      }

      // Narrow in SQL, decide in the pure matcher.
      const candidates: Candidate[] = await db.select({
        id: tosecEntries.id, crc32: tosecEntries.crc32, md5: tosecEntries.md5,
        sha1: tosecEntries.sha1, sizeBytes: tosecEntries.sizeBytes,
      }).from(tosecEntries).where(or(
        b.sha1 ? eq(tosecEntries.sha1, b.sha1) : undefined,
        b.md5 ? eq(tosecEntries.md5, b.md5) : undefined,
        b.crc32 ? and(eq(tosecEntries.crc32, b.crc32), eq(tosecEntries.sizeBytes, b.sizeBytes)) : undefined,
      ));

      const verdict = matchBlob(
        { crc32: b.crc32, md5: b.md5, sha1: b.sha1, sizeBytes: b.sizeBytes },
        candidates,
      );

      await db.update(blobs).set({
        matchState: verdict.state,
        matchCheckedAt: new Date(),
        tosecEntryId: verdict.state === 'matched' ? verdict.entryId : null,
      }).where(eq(blobs.sha256, b.sha256));

      if (verdict.state === 'matched') {
        await applyMatch(b.sha256, verdict.entryId);
        out.matched++;
      } else if (verdict.state === 'ambiguous') out.ambiguous++;
      else out.none++;
    }
  }

  return out;
}

export interface ScanStatus {
  blobs: number; hashed: number; matched: number; none: number;
  ambiguous: number; unchecked: number; tosecEntries: number;
  sets: Array<{ setName: string; setVersion: string | null; entries: number }>;
}

/** Counts for the admin page, including the miss rate design section 2 exists to produce. */
export async function scanStatus(): Promise<ScanStatus> {
  const db = getDb();
  const { rows } = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from blobs)                                          as blobs,
      (select count(*)::int from blobs where hashed_at is not null)              as hashed,
      (select count(*)::int from blobs where match_state = 'matched')            as matched,
      (select count(*)::int from blobs where match_state = 'none')               as none,
      (select count(*)::int from blobs where match_state = 'ambiguous')          as ambiguous,
      (select count(*)::int from blobs where match_checked_at is null)           as unchecked,
      (select count(*)::int from tosec_entries)                                  as tosec_entries
  `);
  const r = rows[0];

  const sets = await db.select({
    setName: tosecEntries.setName,
    setVersion: tosecEntries.setVersion,
    entries: sql<number>`count(*)::int`,
  }).from(tosecEntries).groupBy(tosecEntries.setName, tosecEntries.setVersion);

  return {
    blobs: Number(r.blobs), hashed: Number(r.hashed), matched: Number(r.matched),
    none: Number(r.none), ambiguous: Number(r.ambiguous), unchecked: Number(r.unchecked),
    tosecEntries: Number(r.tosec_entries),
    sets: sets.map((s) => ({ ...s, entries: Number(s.entries) })),
  };
}
```

- [ ] **Step 2: Verify it compiles and commit**

```bash
pnpm vitest run && pnpm build
git add src/lib/tosec-sweep.ts
git commit -m "Add the batched, resumable TOSEC sweeper"
```

---

### Task 9: The cron and admin routes, and `vercel.ts`

**Files:**
- Create: `src/app/api/cron/scan/route.ts`, `src/app/api/admin/scan/route.ts`, `vercel.ts`

**Interfaces:**
- Consumes: `sweep`, `scanStatus`, `requireSuperAdmin`.
- Produces: `GET /api/cron/scan`; `POST /api/admin/scan` → `SweepResult`.

- [ ] **Step 1: The cron route**

`src/app/api/cron/scan/route.ts`:

```ts
import { sweep } from '@/lib/tosec-sweep';

export const maxDuration = 300;

/**
 * Scheduled sweep. NOT behind requireSuperAdmin(): a cron invocation carries
 * no session. The platform's documented mechanism is a shared secret in the
 * Authorization header, so that is the guard.
 *
 * Fails CLOSED when CRON_SECRET is unset -- an unset secret must never mean
 * "allow anyone", which is the same rule SUPERADMIN_EMAILS follows.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return Response.json(await sweep());
}
```

- [ ] **Step 2: The admin route**

`src/app/api/admin/scan/route.ts`:

```ts
import { requireSuperAdmin } from '@/lib/superadmin';
import { sweep } from '@/lib/tosec-sweep';

export const maxDuration = 300;

/** Run one sweep batch on demand. Same work the cron does, different door. */
export async function POST() {
  await requireSuperAdmin();
  return Response.json(await sweep());
}
```

- [ ] **Step 3: Declare the cron**

`vercel.ts` at the repo root — **this repo has no Vercel config file today**, so this is a new file:

```ts
import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  crons: [
    // Nightly. The sweep is resumable and idempotent, so a run that does not
    // finish simply continues on the next one; there is no need for a tight
    // schedule to "catch up".
    { path: '/api/cron/scan', schedule: '0 3 * * *' },
  ],
};
```

Install the config types: `pnpm add -D @vercel/config`

- [ ] **Step 4: Set the secret**

```bash
# Generate and store the shared secret the route checks.
openssl rand -hex 32
```

Add it as `CRON_SECRET` in Vercel (Production) and to `.env.local`. **This is an operator action with a production side effect — record it in Task 11's runbook rather than assuming it is done.**

- [ ] **Step 5: Verify and commit**

```bash
pnpm vitest run && pnpm build
git add src/app/api/cron src/app/api/admin/scan vercel.ts package.json pnpm-lock.yaml
git commit -m "Add the scan cron, its admin trigger, and the Vercel cron config"
```

---

### Task 10: The admin scan page

**Files:**
- Create: `src/app/(admin)/admin/scan/page.tsx`, `src/components/admin/dat-upload.tsx`, `src/components/admin/run-scan-button.tsx`
- Create: `e2e/tosec-helpers.ts`, `e2e/admin-scan.spec.ts`, `e2e/tosec-scan.spec.ts`
- Modify: `src/components/admin/admin-nav.tsx`

**Interfaces:**
- Consumes: `scanStatus`, `requireSuperAdmin`.
- Produces: `seedTosecEntry(...)` from `e2e/tosec-helpers.ts`.

- [ ] **Step 1: The e2e helper**

`e2e/tosec-helpers.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing e2e**

`e2e/tosec-scan.spec.ts`. **The eject test is the point of this file** — without it the suite passes against an implementation that ejects disks from live hardware.

```ts
import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk, pairDevice } from './device-helpers';
import { seedTosecEntry, cleanupTosec } from './tosec-helpers';

test.afterAll(async () => { await cleanupTosec(); await cleanupSeeded(); });

/** Give a blob known hashes directly, so the sweeper's match phase can run. */
async function fakeHashes(sha256: string) {
  const sha1 = createHash('sha1').update(sha256).digest('hex');
  await getDb().update(blobs)
    .set({ sha1, md5: null, crc32: null, hashedAt: new Date() })
    .where(eq(blobs.sha256, sha256));
  return sha1;
}

test('a hash match retitles a badly named disk', async ({ page }) => {
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
  // Deliberately the badly-named case: "stateart" carries no year, no publisher.
  await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  const sha1 = await fakeHashes(sha256);

  await seedTosecEntry({
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  const res = await page.request.post('/api/admin/scan');
  expect(res.ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('State of the Art');
  expect(rows[0].year).toBe(1992);
  expect(rows[0].publisher).toBe('Spaceballs');
  expect(rows[0].metadataSource).toBe('tosec');
});

test('two games TOSEC resolves to one are merged, keeping every disk', async ({ page }) => {
  const user = await signUpFresh(page);
  const shaA = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const shaB = randomUUID().replace(/-/g, '').padEnd(64, '1');
  await seedDisk(user.orgId, { title: 'turrican2', diskNo: 1, sha256: shaA });
  await seedDisk(user.orgId, { title: 'Turrican II', diskNo: 2, sha256: shaB });

  for (const [sha, diskNo] of [[shaA, 1], [shaB, 2]] as const) {
    const sha1 = await fakeHashes(sha);
    await seedTosecEntry({
      gameName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2)`,
      romName: `Turrican II (1991)(Rainbow Arts)(Disk ${diskNo} of 2).adf`,
      sha1, title: 'Turrican II', sortTitle: 'turrican ii',
      year: 1991, publisher: 'Rainbow Arts', diskNo, diskCount: 2,
    });
  }

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const db = getDb();
  const rows = await db.select().from(games).where(eq(games.orgId, user.orgId));
  expect(rows).toHaveLength(1);
  const kept = await db.select().from(disks).where(eq(disks.gameId, rows[0].id));
  expect(kept).toHaveLength(2);
});

test('a sweep is NEVER observable as an eject', async ({ page, request }) => {
  // The hazard this whole design is shaped around. devices.desiredDiskId has
  // no foreign key and readDesired joins on it; if a sweep re-keyed disks the
  // join would return nothing, and "no disk desired" IS eject.
  const user = await signUpFresh(page);
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '2');
  const { diskId } = await seedDisk(user.orgId, { title: 'stateart', diskNo: 1, sha256 });
  // pairDevice is the only device-creating helper this repo has: it goes
  // through the real pair + register flow and registers the id for cleanup.
  const device = await pairDevice(page, request, 'Eject canary');

  const db = getDb();
  await db.update(devices).set({
    desiredSha256: sha256, desiredDiskId: diskId, desiredDiskNo: 1, desiredVersion: 7,
  }).where(eq(devices.id, device.deviceId));

  const sha1 = await fakeHashes(sha256);
  await seedTosecEntry({
    gameName: 'State of the Art (1992)(Spaceballs)',
    romName: 'State of the Art (1992)(Spaceballs).adf',
    sha1, title: 'State of the Art', sortTitle: 'state of the art',
    year: 1992, publisher: 'Spaceballs',
  });

  await signInAsSuperAdmin(page);
  expect((await page.request.post('/api/admin/scan')).ok()).toBe(true);

  const after = (await db.select().from(devices).where(eq(devices.id, device.deviceId)))[0];
  expect(after.desiredDiskId, 'a sweep must not move desired state').toBe(diskId);
  expect(after.desiredSha256).toBe(sha256);
  expect(after.desiredVersion, 'a sweep must not bump the version').toBe(7);
  // The disk row itself must still exist under the same id.
  expect(await db.select().from(disks).where(eq(disks.id, diskId))).toHaveLength(1);
});
```

**Note the ordering constraint:** `pairDevice` posts to `/api/devices/pair` using `page`'s session, so it must run while the page is signed in as the *tenant* — before `signInAsSuperAdmin(page)` replaces that session. The test above is written in that order; do not reorder it.

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm e2e e2e/tosec-scan.spec.ts`
Expected: FAIL — `/api/admin/scan` does not exist yet if Task 9 is unmerged, or the assertions fail because nothing applies matches.

- [ ] **Step 4: Build the page and controls**

`src/app/(admin)/admin/scan/page.tsx`:

```tsx
import { scanStatus } from '@/lib/tosec-sweep';
import { PageHeader } from '@/components/shell/page-header';
import { DatUpload } from '@/components/admin/dat-upload';
import { RunScanButton } from '@/components/admin/run-scan-button';

export const dynamic = 'force-dynamic';

const TILES = [
  { key: 'blobs', label: 'Blobs' },
  { key: 'hashed', label: 'Hashed' },
  { key: 'matched', label: 'Matched' },
  { key: 'none', label: 'No match' },
  { key: 'ambiguous', label: 'Ambiguous' },
  { key: 'unchecked', label: 'Unchecked' },
] as const;

export default async function AdminScanPage() {
  const s = await scanStatus();
  const decided = s.matched + s.none + s.ambiguous;
  // The number this whole increment exists to produce (design section 2).
  const missRate = decided === 0 ? null : Math.round((s.none / decided) * 100);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Scan"
        subtitle={`${s.tosecEntries} TOSEC entries loaded${missRate === null ? '' : ` · ${missRate}% of decided blobs unmatched`}`}
        actions={<RunScanButton />}
      />
      <div className="px-7 pb-10">
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          {TILES.map((t) => (
            <div key={t.key} className="glass-card p-5">
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                {t.label}
              </div>
              <div
                className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em]"
                data-testid={`scan-${t.key}`}
              >
                {s[t.key]}
              </div>
            </div>
          ))}
        </div>

        {s.unchecked > 0 && (
          <div className="glass-card mb-3 p-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            <strong>{s.unchecked}</strong> blobs still to process. Each run is bounded and
            resumable — press <strong>Run now</strong> again, or wait for the nightly cron.
          </div>
        )}

        <div className="glass-card mb-3 p-5">
          <DatUpload />
        </div>

        <div className="glass-card overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-3 text-left font-semibold">TOSEC set</th>
                <th className="px-4 py-3 text-left font-semibold">Version</th>
                <th className="px-4 py-3 text-right font-semibold">Entries</th>
              </tr>
            </thead>
            <tbody>
              {s.sets.length === 0 ? (
                <tr>
                  <td className="px-4 py-3" colSpan={3} style={{ color: 'var(--muted)' }}>
                    No DAT sets loaded. Nothing can be matched until one is uploaded.
                  </td>
                </tr>
              ) : (
                s.sets.map((set) => (
                  <tr key={`${set.setName}:${set.setVersion}`} className="border-t"
                      style={{ borderColor: 'rgb(0 0 0 / 0.06)' }}>
                    <td className="px-4 py-3">{set.setName}</td>
                    <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                      {set.setVersion ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{set.entries}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
```

`src/components/admin/dat-upload.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function DatUpload() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Multiple files, imported one at a time. TOSEC ships the Amiga sets as
  // ~223 separate DATs and an operator realistically wants several of them
  // (Games - [ADF], Applications - [ADF], Games - Public Domain - [ADF], ...).
  // One-file-at-a-time would make a deliberately manual process unusable;
  // this keeps it manual without making it tedious. Sequential, not parallel:
  // each import is a large parse and the route is not worth stampeding.
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    if (files.length === 0) return;
    setBusy(true);
    let ok = 0;
    let entries = 0;
    const failed: string[] = [];
    try {
      for (const file of files) {
        setProgress(`${file.name} (${ok + failed.length + 1}/${files.length})`);
        // Read in the browser and POST the raw text: the route takes
        // request.text(), so there is no multipart parsing on the server.
        const text = await file.text();
        let res: Response;
        try {
          res = await fetch('/api/admin/tosec', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: text,
          });
        } catch {
          // A network failure aborts the run: the rest would almost
          // certainly fail the same way, and a partial import is easier to
          // reason about than a long list of identical errors.
          toast.error('Could not reach the server', {
            description: `Stopped at ${file.name}. ${ok} of ${files.length} imported.`,
          });
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // One bad file does not abandon the rest -- an operator selecting a
          // whole directory will inevitably include a non-DAT.
          failed.push(file.name);
          continue;
        }
        ok++;
        entries += body.imported ?? 0;
      }

      if (ok > 0) {
        toast.success(`Imported ${entries} entries from ${ok} file${ok === 1 ? '' : 's'}`, {
          description: failed.length > 0 ? `${failed.length} skipped: ${failed.join(', ')}` : undefined,
        });
      } else {
        toast.error('Nothing imported', {
          description: `${failed.length} file(s) rejected — are these really TOSEC DATs?`,
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="dat-file" className="text-[12.5px] font-semibold">
        Import a TOSEC DAT
      </label>
      <input
        id="dat-file"
        ref={input}
        type="file"
        accept=".dat,.xml"
        multiple
        disabled={busy}
        onChange={onChange}
        data-testid="dat-upload"
        className="text-[13px]"
      />
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {busy
          ? `Importing ${progress ?? '…'}`
          : 'Select one or more .dat files. ClrMamePro or XML; re-importing a set updates it in place.'}
      </span>
    </div>
  );
}
```

`src/components/admin/run-scan-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function RunScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch('/api/admin/scan', { method: 'POST' });
      } catch {
        toast.error('Could not reach the server', {
          description: 'Check your connection and try again.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('The scan failed', { description: `The server answered ${res.status}.` });
        return;
      }
      const r = await res.json();
      toast.success(
        r.done ? 'Scan complete' : 'Batch done — more to do',
        { description: `${r.hashed} hashed · ${r.matched} matched · ${r.none} unmatched · ${r.ambiguous} ambiguous` },
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid="run-scan"
      className="h-[34px] rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
      style={{ background: 'var(--on-dark)', color: '#16273a' }}
    >
      {/* A pass is bounded at ~240 s, so say it is working rather than looking hung. */}
      {busy ? 'Scanning…' : 'Run now'}
    </button>
  );
}
```

Add `{ href: '/admin/scan', label: 'Scan' }` to `ITEMS` in `src/components/admin/admin-nav.tsx`.

- [ ] **Step 5: Write the admin guard e2e**

`e2e/admin-scan.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

test('the admin sees the scan status page', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/scan');
  await expect(page.getByRole('heading', { name: /scan/i })).toBeVisible();
  await expect(page.getByTestId('scan-blobs')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('scan-unchecked')).toHaveText(/^\d+$/);
});

test('a non-admin cannot reach the scan page or its APIs', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/admin/scan');
  await expect(page).toHaveURL(/\/library/);

  // 307 with maxRedirects:0 -- this codebase redirects unauthorized API
  // callers rather than returning a 4xx (see e2e/admin-invites.spec.ts).
  for (const path of ['/api/admin/scan', '/api/admin/tosec']) {
    const res = await page.request.post(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(res.headers()['location'], path).toContain('/library');
  }
});

test('the cron route refuses a caller with no secret', async ({ request }) => {
  expect((await request.get('/api/cron/scan')).status()).toBe(401);
  const bad = await request.get('/api/cron/scan', { headers: { authorization: 'Bearer nope' } });
  expect(bad.status()).toBe(401);
});
```

- [ ] **Step 6: Run everything green**

```bash
pnpm vitest run && pnpm build && pnpm e2e
```

- [ ] **Step 7: Mutate, twice**

Both prove a test that would otherwise pass vacuously:

1. In `tosec-apply.ts`, make the game update unconditional by dropping `eq(games.metadataSource, 'filename')`. Confirm nothing fails — **then add a test that does**, asserting a game with `metadataSource='manual'` is left alone. Revert.
2. In `mergeDuplicates`, add `stmts.push(db.update(disks).set({ id: ... }))` — or more simply, change `applyMatch` to also update `disks.id`. Confirm **`a sweep is NEVER observable as an eject` fails**. Revert.

**Run these against a scratch org only.** Mutation 2 is destructive by design; unlike the super-admin plan's `DELETE FROM games`, these are scoped by `sha256` and `orgId`, so they cannot empty a table for every tenant — verify that claim before running, and stop if it does not hold.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(admin)/admin/scan" src/components/admin e2e/tosec-helpers.ts e2e/tosec-scan.spec.ts e2e/admin-scan.spec.ts
git commit -m "Add the admin scan page, its controls, and the eject-hazard test"
```

---

### Task 11: Backfill, measure, and document

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-08-31-tosec-identity-scan-design.md`

- [ ] **Step 1: Operator steps, in order**

1. Download the Amiga TOSEC sets you want from tosecdev.org.
2. `openssl rand -hex 32`, then set `CRON_SECRET` in Vercel (Production) **and** `.env.local`.
3. Upload the DATs at `/admin/scan`.
4. Press **Run now** repeatedly until `unchecked` reaches 0. The 850 blobs need several passes; each is resumable.

- [ ] **Step 2: Record the miss rate**

This number is the whole reason Increment A came first. Write it into `HANDOFF.md`: matched / none / ambiguous over the **real** disks, noting that e2e fixture blobs inflate the denominator and should be excluded by filtering to `size_bytes = 901120`.

- [ ] **Step 3: Update `HANDOFF.md`**

A "TOSEC identity scan" section: what shipped, that `CRON_SECRET` is required and fails closed when unset, that the sweeper is resumable and safe to re-run, and — most importantly — **the never-re-key rule and why**, since that is the constraint a future change is most likely to break silently.

- [ ] **Step 4: Mark the spec delivered**

Append a "What this increment delivered" section, including the measured miss rate and what it implies for Increment B, given NDOS disks have no filesystem to read.

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md docs/superpowers/specs/2026-08-31-tosec-identity-scan-design.md
git commit -m "Record the TOSEC identity scan as delivered, with the measured miss rate"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean.
- `unchecked` is 0 on `/admin/scan`, and the miss rate is recorded in `HANDOFF.md`.
- The eject test was observed to **fail** when disk ids are re-derived, and to pass otherwise.
- A `metadataSource='manual'` row was observed to survive a sweep.
- A non-admin was observed to be rejected by `/api/admin/scan` and `/api/admin/tosec` independently of the page guard, and `/api/cron/scan` rejects a caller with no secret.
- `CRON_SECRET` is set in Vercel Production, and `vercel crons ls` shows the schedule.
