# Write-back piece 2a: the server side — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server half of write-back:
- tables for disk history and open write sessions;
- `POST /api/device/write` and `/api/device/write/close`;
- a history version for every browser edit and rename;
- write-protect changes that reach a mounted board live;
- a scanner rate and an e2e teardown that understand written disks.

The board does not use any of this until plan 2b.

**Architecture:**
- The storage logic is pure and host-tested:
  - `src/lib/disk-history/version.ts` plans the next version with the existing `delta.ts`/`chain.ts`;
  - `overlayTracks` builds an image from staged tracks.
- One module, `src/lib/disk-history/store.ts`, is the only writer of a new image. It stores the
  blob, entitlement and version rows, and repoints the disk. Browser edits, renames and device
  closes all go through it.
- `src/lib/device-write.ts` holds the session rules behind the two device routes.

**Tech stack:** Next.js App Router route handlers, Drizzle ORM on neon-http (`db.batch`, no
interactive transactions), Vercel Blob via `diskStore`, zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md` §3.3–§3.5
(§3.4 as amended 2026-09-18).

## Global constraints

- **History modules exist and are reused, not rewritten:** `src/lib/disk-history/delta.ts`
  (`buildDelta`, `encodeDelta`, `decodeDelta`, `applyDelta`, `SECTOR_BYTES = 512`,
  `SECTORS_PER_DISK = 1760`) and `chain.ts` (`VersionEntry`, `nextKind`, `deltasSinceSnapshot`,
  `materialise`, `MAX_CHAIN_DEPTH = 64`).
- `ADF_BYTES = 901120`, `TRACK_DATA_BYTES = 5632`, `TRACKS = 160`, all from `@/lib/adfmfm`.
- Every device route:
  - authenticates with `requireDevice` + `deviceAuthResponse`;
  - sets `cache-control: no-store` on **every** response;
  - exports `maxDuration = 60`;
  - on error returns `{ error: '<snake_case>' }` with a plain string.
- `disks.id` never changes. Every new image gets a `blobs` row **and** an `entitlements` row
  for the org. The old blob is never deleted.
- **Delta blobs go to `diskStore.put` only, never to the `blobs` table.**
- Tests: `pnpm vitest run <file>` for unit tests. Vitest has **no `DATABASE_URL`**, so
  DB-touching code is covered by Playwright (`pnpm exec playwright test <file>`), which runs
  **against the live production database**; the global teardown cleans up `@example.test`
  users.
- A migration only reaches the live DB via `pnpm db:push`. **Implementers do NOT run
  `db:push`.** The controller runs it once, after Task 1's review. Any index created in SQL
  must also be declared with `index(...)` in the schema, or `db:push` drops it.
- Run e2e **only your own spec file**, in the foreground (timeout up to 600000 ms). Never the
  full suite: the controller runs it. No `git stash`, no `git add -A`; stage explicit paths.
- Before diagnosing any e2e failure as code: `lsof -tiTCP:3000` must be empty and no other
  Playwright process may be alive. Then re-run the spec alone.

---

### Task 1: Schema and migration

**Files:**
- Create: `src/db/schema/disk-history.ts`
- Modify: `src/db/index.ts`
- Create: `drizzle/0015_*.sql` (generated) and the `drizzle/meta/` snapshot changes
- Test: `src/db/disk-history-schema.test.ts`

**Interfaces:**
- Produces:
  - `diskVersions`, with columns `id, diskId, orgId, seq, kind, blobSha256, imageSha256, source,
    deviceId, userId, rewindOf, sectorCount, createdAt`;
  - `diskWriteSessions` (`deviceId, mount, diskId, lastSeq, openedAt`);
  - `diskWriteTracks` (`deviceId, mount, track, data: Uint8Array`);
  - `bytea` custom type (module-private).

- [ ] **Step 1: Write the failing schema test** at `src/db/disk-history-schema.test.ts`. It
lives outside `src/db/schema/` because drizzle-kit loads every `*.ts` there, and a Vitest
import breaks `db:generate`. `src/db/devices-schema.test.ts` explains the same constraint.

```ts
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { diskVersions, diskWriteSessions, diskWriteTracks } from './schema/disk-history';

describe('disk history schema', () => {
  it('a version belongs to a disk and dies with it', () => {
    const cfg = getTableConfig(diskVersions);
    expect(cfg.name).toBe('disk_versions');
    const fk = cfg.foreignKeys.map((f) => f.reference());
    expect(fk.some((r) => r.foreignTable[Symbol.for('drizzle:Name')] === 'disks'
      && f0(r.foreignColumns) === 'id')).toBe(true);
    expect(cfg.foreignKeys.every((f) => f.onDelete === 'cascade')).toBe(true);
  });

  it('seq is unique per disk, and versions are findable by image digest', () => {
    const cfg = getTableConfig(diskVersions);
    expect(cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name).join(',')))
      .toContain('disk_id,seq');
    expect(cfg.indexes.map((i) => i.config.name)).toContain('disk_versions_image_idx');
  });

  it('one open session per device and mount; one staged row per track', () => {
    expect(getTableConfig(diskWriteSessions).primaryKeys[0].columns.map((c) => c.name))
      .toEqual(['device_id', 'mount']);
    expect(getTableConfig(diskWriteTracks).primaryKeys[0].columns.map((c) => c.name))
      .toEqual(['device_id', 'mount', 'track']);
  });

  it('staged track bytes are bytea, and not null', () => {
    expect(diskWriteTracks.data.getSQLType()).toBe('bytea');
    expect(diskWriteTracks.data.notNull).toBe(true);
  });
});

function f0(cols: { name: string }[]): string { return cols[0]?.name ?? ''; }
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run src/db/disk-history-schema.test.ts`.
Expected: FAIL, because `./schema/disk-history` does not exist.

- [ ] **Step 3: Write the schema** at `src/db/schema/disk-history.ts`:

```ts
import {
  pgTable, text, integer, timestamp, index, unique, primaryKey, foreignKey, customType,
} from 'drizzle-orm/pg-core';
import { disks } from './catalog';
import { devices } from './devices';

// Staged track bytes are the ONE bytea in this schema, deliberately (write-back
// spec §3.4): transient scratch, at most 160 x 5,632 bytes per open session,
// deleted at close. Disk images and history deltas live in the blob store.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() { return 'bytea'; },
  toDriver(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); },
  fromDriver(v) {
    // neon-http returns bytea as a '\x..' hex string; the pg driver as a Buffer.
    if (typeof v === 'string') return Uint8Array.from(Buffer.from(v.slice(2), 'hex'));
    return new Uint8Array(v);
  },
});

/**
 * A disk's history, one row per version (write-back spec §3.4). Version 0 is
 * the image when history began (a snapshot of the blob the disk held then);
 * each later version is a snapshot or a sector delta, per chain.ts. Rows die
 * with the disk.
 */
export const diskVersions = pgTable('disk_versions', {
  id: text('id').primaryKey(),
  diskId: text('disk_id').notNull().references(() => disks.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind').notNull(),                 // 'snapshot' | 'delta'
  blobSha256: text('blob_sha256').notNull(),    // snapshot: the image; delta: the WDLD blob
  imageSha256: text('image_sha256').notNull(),  // the COMPLETE image at this version
  source: text('source').notNull(),             // 'original' | 'amiga' | 'browser' | 'rewind'
  deviceId: text('device_id'),
  userId: text('user_id'),
  rewindOf: integer('rewind_of'),
  sectorCount: integer('sector_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('disk_versions_disk_seq').on(t.diskId, t.seq),
  index('disk_versions_image_idx').on(t.imageSha256),
]);

/** An open write session: one per (device, mount). The idempotence key's high-water mark. */
export const diskWriteSessions = pgTable('disk_write_sessions', {
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  mount: integer('mount').notNull(),
  diskId: text('disk_id').notNull().references(() => disks.id, { onDelete: 'cascade' }),
  lastSeq: integer('last_seq').notNull().default(0),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.deviceId, t.mount] })]);

/** Tracks uploaded in an open session. A later upload of a track replaces it. */
export const diskWriteTracks = pgTable('disk_write_tracks', {
  deviceId: text('device_id').notNull(),
  mount: integer('mount').notNull(),
  track: integer('track').notNull(),
  data: bytea('data').notNull(),
}, (t) => [
  primaryKey({ columns: [t.deviceId, t.mount, t.track] }),
  foreignKey({
    columns: [t.deviceId, t.mount],
    foreignColumns: [diskWriteSessions.deviceId, diskWriteSessions.mount],
  }).onDelete('cascade'),
]);
```

- [ ] **Step 4: Register it** in `src/db/index.ts`. Add
`import * as diskHistory from './schema/disk-history';` beside the other schema imports, and
`...diskHistory` to the `schema` object.

- [ ] **Step 5: Run the test and confirm it passes.** Run `pnpm vitest run src/db/disk-history-schema.test.ts`.
Expected: PASS. If `getTableConfig(...).foreignKeys[*].reference()` differs in shape in this
drizzle version, adjust **only the assertion's accessors**, keeping what it asserts: a
cascading FK to `disks.id`. Say so in the report.

- [ ] **Step 6: Generate the migration.** Run `pnpm db:generate`. Expected: a new
`drizzle/0015_<name>.sql` creating the three tables, the unique constraint, the index and the
FKs. Read it and confirm that it only CREATEs, with no DROP or ALTER of existing tables. **Do
not run `pnpm db:push`.**

- [ ] **Step 7: Full unit suite and type check.** Run `pnpm vitest run` and `pnpm exec tsc --noEmit`.
Expected: green, and no type errors.

- [ ] **Step 8: Commit.**

```bash
git status --short
git add src/db/schema/disk-history.ts src/db/index.ts src/db/disk-history-schema.test.ts drizzle/
git commit -m "Schema: disk history and write sessions

disk_versions (one row per version, cascading from disks), and the open
write session with its staged tracks -- the one bytea, transient by design
(write-back spec 3.4). Migration generated, not yet pushed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Planning the next version (pure)

**Files:**
- Create: `src/lib/disk-history/version.ts`
- Test: `src/lib/disk-history/version.test.ts`

**Interfaces:**
- Consumes: `buildDelta`, `encodeDelta`, `SECTOR_BYTES` (`delta.ts`); `VersionEntry`,
  `VersionKind`, `nextKind`, `deltasSinceSnapshot` (`chain.ts`); `ADF_BYTES`,
  `TRACK_DATA_BYTES`, `TRACKS` (`@/lib/adfmfm`).
- Produces:
  - `interface StagedTrack { track: number; data: Uint8Array }`
  - `function overlayTracks(head: Uint8Array, tracks: readonly StagedTrack[]): Uint8Array`
  - `interface PlannedVersion { kind: VersionKind; sectorCount: number; deltaBlob: Uint8Array | null }`
  - `function planNextVersion(entries: readonly VersionEntry[], head: Uint8Array, next: Uint8Array): PlannedVersion | null`
    (null means identical)
  - `function isTrackUpload(track: number, data: Uint8Array): boolean`

- [ ] **Step 1: Write the failing tests** in `src/lib/disk-history/version.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ADF_BYTES, TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { decodeDelta, SECTOR_BYTES } from './delta';
import type { VersionEntry } from './chain';
import { MAX_CHAIN_DEPTH } from './chain';
import { overlayTracks, planNextVersion, isTrackUpload } from './version';

const img = (fill = 0) => new Uint8Array(ADF_BYTES).fill(fill);
const track = (fill: number) => new Uint8Array(TRACK_DATA_BYTES).fill(fill);
const v0: VersionEntry = { seq: 0, kind: 'snapshot', blobSha256: 'a', imageSha256: 'a' };

describe('overlayTracks', () => {
  it('replaces exactly the staged tracks and nothing else', () => {
    const out = overlayTracks(img(0), [{ track: 3, data: track(7) }]);
    expect(out[3 * TRACK_DATA_BYTES - 1]).toBe(0);
    expect(out[3 * TRACK_DATA_BYTES]).toBe(7);
    expect(out[4 * TRACK_DATA_BYTES - 1]).toBe(7);
    expect(out[4 * TRACK_DATA_BYTES]).toBe(0);
  });
  it('does not modify the head it was given', () => {
    const head = img(0);
    overlayTracks(head, [{ track: 0, data: track(9) }]);
    expect(head[0]).toBe(0);
  });
  it('refuses a head that is not a disk, or a track out of range', () => {
    expect(() => overlayTracks(new Uint8Array(10), [])).toThrow();
    expect(() => overlayTracks(img(), [{ track: 160, data: track(1) }])).toThrow();
    expect(() => overlayTracks(img(), [{ track: 0, data: new Uint8Array(5) }])).toThrow();
  });
});

describe('isTrackUpload', () => {
  it('accepts tracks 0..159 of exactly 5,632 bytes', () => {
    expect(isTrackUpload(0, track(0))).toBe(true);
    expect(isTrackUpload(159, track(0))).toBe(true);
    expect(isTrackUpload(160, track(0))).toBe(false);
    expect(isTrackUpload(-1, track(0))).toBe(false);
    expect(isTrackUpload(1.5, track(0))).toBe(false);
    expect(isTrackUpload(0, new Uint8Array(5631))).toBe(false);
  });
});

describe('planNextVersion', () => {
  it('is null when nothing changed', () => {
    expect(planNextVersion([v0], img(0), img(0))).toBeNull();
  });
  it('an ordinary save is a delta of only the sectors that changed', () => {
    const next = img(0);
    next[5 * SECTOR_BYTES] = 1;      // one byte in sector 5
    next[900 * SECTOR_BYTES + 3] = 2; // one in sector 900
    const p = planNextVersion([v0], img(0), next)!;
    expect(p.kind).toBe('delta');
    expect(p.sectorCount).toBe(2);
    expect(decodeDelta(p.deltaBlob!).sectors).toEqual([5, 900]);
  });
  it('a rewrite of most of the disk is a snapshot, with no delta blob', () => {
    const p = planNextVersion([v0], img(0), img(1))!;
    expect(p.kind).toBe('snapshot');
    expect(p.deltaBlob).toBeNull();
    expect(p.sectorCount).toBe(ADF_BYTES / SECTOR_BYTES);
  });
  it('snapshots once the chain is MAX_CHAIN_DEPTH deltas long', () => {
    const entries: VersionEntry[] = [v0];
    for (let s = 1; s <= MAX_CHAIN_DEPTH; s++) {
      entries.push({ seq: s, kind: 'delta', blobSha256: `d${s}`, imageSha256: `i${s}` });
    }
    const next = img(0); next[0] = 1;
    expect(planNextVersion(entries, img(0), next)!.kind).toBe('snapshot');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run src/lib/disk-history/version.test.ts`.
Expected: FAIL, because `./version` does not exist.

- [ ] **Step 3: Implement** `src/lib/disk-history/version.ts`:

```ts
import { ADF_BYTES, TRACK_DATA_BYTES, TRACKS } from '@/lib/adfmfm';
import { buildDelta, encodeDelta } from './delta';
import { nextKind, deltasSinceSnapshot, type VersionEntry, type VersionKind } from './chain';

/**
 * Turning a write session into the next version of a disk (write-back spec
 * §3.4). Pure: the store (store.ts) does the I/O, this decides what to store.
 */

export interface StagedTrack { track: number; data: Uint8Array }

/** A track the board may upload: 0..159, exactly one track of sector data. */
export function isTrackUpload(track: number, data: Uint8Array): boolean {
  return Number.isInteger(track) && track >= 0 && track < TRACKS
    && data.length === TRACK_DATA_BYTES;
}

/** `head` with each staged track written over it. Does not modify `head`. */
export function overlayTracks(head: Uint8Array, tracks: readonly StagedTrack[]): Uint8Array {
  if (head.length !== ADF_BYTES) throw new Error(`head must be ${ADF_BYTES} bytes, got ${head.length}`);
  const out = head.slice();
  for (const t of tracks) {
    if (!isTrackUpload(t.track, t.data)) throw new Error(`not a track upload: track ${t.track}`);
    out.set(t.data, t.track * TRACK_DATA_BYTES);
  }
  return out;
}

export interface PlannedVersion {
  kind: VersionKind;
  /** Sectors that differ from the previous version. */
  sectorCount: number;
  /** The encoded WDLD delta for a 'delta'; null for a 'snapshot' (the image is the blob). */
  deltaBlob: Uint8Array | null;
}

/** What to record for `next`, given the history so far. Null when nothing changed. */
export function planNextVersion(
  entries: readonly VersionEntry[], head: Uint8Array, next: Uint8Array,
): PlannedVersion | null {
  const delta = buildDelta(head, next);
  if (delta.sectors.length === 0) return null;
  const kind = nextKind(delta.sectors.length, deltasSinceSnapshot(entries));
  return {
    kind,
    sectorCount: delta.sectors.length,
    deltaBlob: kind === 'delta' ? encodeDelta(delta) : null,
  };
}
```

- [ ] **Step 4: Run and confirm they pass.** Run `pnpm vitest run src/lib/disk-history/`.
Expected: PASS, with the existing `chain`/`delta` tests still green.

- [ ] **Step 5: Mutation check.** Change `deltasSinceSnapshot(entries)` to `0` and confirm that
"snapshots once the chain is MAX_CHAIN_DEPTH deltas long" fails. Revert.

- [ ] **Step 6: Commit.**

```bash
git status --short
git add src/lib/disk-history/version.ts src/lib/disk-history/version.test.ts
git commit -m "disk-history: plan the next version from a session's tracks

overlayTracks builds the new image; planNextVersion decides delta or
snapshot with the existing chain rules and encodes the delta. Pure.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The history store, and browser edits and renames recorded through it

**Files:**
- Create: `src/lib/disk-history/store.ts`
- Modify: `src/lib/disk-write.ts` (the store section of `applyDiskEdit`, and its signature)
- Modify: `src/lib/disk-write.test.ts` (mock the store)
- Modify: every caller of `applyDiskEdit`. Find them with
  `grep -rln "applyDiskEdit(" src/app` and pass `userId` from `requireOrg()`.
- Modify: `src/app/api/disks/[id]/volume-name/route.ts`
- Test: `e2e/disk-history.spec.ts`

**Interfaces:**
- Consumes: `planNextVersion` (Task 2); `diskVersions` (Task 1); `diskStore`, `blobs`,
  `entitlements`, `disks`.
- Produces:
  - `type VersionSource = 'amiga' | 'browser' | 'rewind'`
  - `interface RecordInput { orgId: string; diskId: string; headSha: string; head: Uint8Array; next: Uint8Array; source: VersionSource; deviceId?: string | null; userId?: string | null; rewindOf?: number | null; sourceFilename: string }`
  - `interface Recorded { sha256: string; seq: number; kind: VersionKind; sectorCount: number }`
  - `async function recordVersion(input: RecordInput): Promise<Recorded | null>` (null means
    identical; nothing is written)
  - `async function loadEntries(diskId: string): Promise<VersionEntry[]>`
  - `applyDiskEdit(orgId, diskId, edit, userId: string | null = null)`: a new optional 4th
    parameter.

- [ ] **Step 1: Write the failing e2e** at `e2e/disk-history.spec.ts`. It renames a real
formatted disk through the route and asserts the history:

```ts
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { decodeDelta } from '@/lib/disk-history/delta';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const deltaShas: string[] = [];

test.afterAll(async () => {
  for (const s of deltaShas) { try { await diskStore.remove(s); } catch { /* never uploaded */ } }
  await cleanupSeeded();
});

async function versions(diskId: string) {
  return getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, diskId)).orderBy(asc(diskVersions.seq));
}

test('a rename is recorded as a browser version on top of version 0', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `Hist${runTag().slice(0, 6)}` });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, { title: `History ${runTag()}`, diskNo: 1, sha256: original });

  const res = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'Renamed' } });
  expect(res.status()).toBe(200);
  const { sha256: renamed } = await res.json();

  const rows = await versions(diskId);
  expect(rows.map((r) => [r.seq, r.kind, r.source])).toEqual([
    [0, 'snapshot', 'original'],
    [1, 'delta', 'browser'],
  ]);
  expect(rows[0].imageSha256).toBe(original);
  expect(rows[0].blobSha256).toBe(original);
  expect(rows[1].imageSha256).toBe(renamed);
  expect(rows[1].userId).not.toBeNull();
  expect(rows[1].sectorCount).toBeGreaterThan(0);

  // The delta is a real WDLD blob in the store, and only names changed sectors.
  deltaShas.push(rows[1].blobSha256);
  const delta = decodeDelta(await diskStore.read(rows[1].blobSha256));
  expect(delta.sectors.length).toBe(rows[1].sectorCount);

  const [disk] = await getDb().select().from(disks).where(eq(disks.id, diskId));
  expect(disk.sha256).toBe(renamed);
});

test('renaming to the same name records nothing', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  const adf = formatVolume({ filesystem: 'OFS', volumeName: 'Same' });
  const s = sha(adf);
  await diskStore.put(s, adf);
  const { diskId } = await seedDisk(orgId, { title: `Same ${runTag()}`, diskNo: 1, sha256: s });
  const res = await page.request.patch(`/api/disks/${diskId}/volume-name`, { data: { volumeName: 'Same' } });
  expect(res.status()).toBe(200);
  expect(await versions(diskId)).toEqual([]);
});
```

`seedDisk` inserts a `blobs` row with `storageKey: adf/<sha>`. The test PUTs the real bytes
with `diskStore.put`, so the route can read them. The seeded sha is tracked by `cleanupSeeded`.

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm exec playwright test e2e/disk-history.spec.ts`.
Expected: the first test fails with `rows` being `[]`, because nothing records history yet.
If the migration is not yet on the live DB, the failure is a missing `disk_versions` relation
instead. In that case stop and report NEEDS_CONTEXT: the controller applies the migration.

- [ ] **Step 3: Implement the store** at `src/lib/disk-history/store.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { blobs, disks, entitlements } from '@/db/schema/catalog';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import type { VersionEntry, VersionKind } from './chain';
import { planNextVersion } from './version';

/**
 * The ONLY writer of a disk's new image (write-back spec §3.4). Browser
 * edits, renames, device write sessions and restores all come through here,
 * so every change to a disk's bytes lands in its history the same way.
 */

export type VersionSource = 'amiga' | 'browser' | 'rewind';

export interface RecordInput {
  orgId: string;
  diskId: string;
  /** The digest the disk points at now, and its bytes. */
  headSha: string;
  head: Uint8Array;
  next: Uint8Array;
  source: VersionSource;
  deviceId?: string | null;
  userId?: string | null;
  rewindOf?: number | null;
  /** Carried onto the new image's entitlement row. */
  sourceFilename: string;
}

export interface Recorded { sha256: string; seq: number; kind: VersionKind; sectorCount: number }

const sha256Of = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export async function loadEntries(diskId: string): Promise<VersionEntry[]> {
  const rows = await getDb()
    .select({
      seq: diskVersions.seq, kind: diskVersions.kind,
      blobSha256: diskVersions.blobSha256, imageSha256: diskVersions.imageSha256,
    })
    .from(diskVersions)
    .where(eq(diskVersions.diskId, diskId))
    .orderBy(asc(diskVersions.seq));
  return rows.map((r) => ({ ...r, kind: r.kind as VersionKind }));
}

/**
 * Store `next` as the disk's new image and record it as the next version.
 * Null when `next` equals `head`: nothing is written at all.
 *
 * Blob bytes are PUT first, then every row in one db.batch. A PUT whose rows
 * never land leaves an unreferenced object (reclaimable); rows whose bytes
 * never landed would name a disk nobody can read.
 */
export async function recordVersion(input: RecordInput): Promise<Recorded | null> {
  const db = getDb();
  const entries = await loadEntries(input.diskId);

  // Version 0 is the image when history began: created lazily at the first
  // change, so a disk never written costs nothing (chain.ts).
  const history: VersionEntry[] = entries.length
    ? entries
    : [{ seq: 0, kind: 'snapshot', blobSha256: input.headSha, imageSha256: input.headSha }];

  const plan = planNextVersion(history, input.head, input.next);
  if (!plan) return null;

  const sha256 = sha256Of(input.next);
  const seq = history[history.length - 1].seq + 1;

  await diskStore.put(sha256, input.next);
  let blobSha256 = sha256;
  if (plan.deltaBlob) {
    // A delta is not a disk image: stored, but never a `blobs` row, which is
    // the table the scanners walk as disks.
    blobSha256 = sha256Of(plan.deltaBlob);
    await diskStore.put(blobSha256, plan.deltaBlob);
  }

  const stmts: BatchItem<'pg'>[] = [];
  stmts.push(db.insert(blobs).values({
    sha256, sizeBytes: input.next.length, storageKey: diskStore.storageKey(sha256),
  }).onConflictDoNothing());
  // The entitlement is what lets this org read the new bytes at all, and what
  // keeps the e2e teardown's GC from reclaiming a snapshot history needs.
  stmts.push(db.insert(entitlements).values({
    orgId: input.orgId, sha256, sourceFilename: input.sourceFilename,
  }).onConflictDoNothing());
  if (!entries.length) {
    stmts.push(db.insert(diskVersions).values({
      id: randomUUID(), diskId: input.diskId, orgId: input.orgId, seq: 0,
      kind: 'snapshot', blobSha256: input.headSha, imageSha256: input.headSha,
      source: 'original', sectorCount: 0,
    }));
  }
  stmts.push(db.insert(diskVersions).values({
    id: randomUUID(), diskId: input.diskId, orgId: input.orgId, seq,
    kind: plan.kind, blobSha256, imageSha256: sha256, source: input.source,
    deviceId: input.deviceId ?? null, userId: input.userId ?? null,
    rewindOf: input.rewindOf ?? null, sectorCount: plan.sectorCount,
  }));
  // disks.id is NEVER part of this SET -- only sha256 moves.
  stmts.push(db.update(disks).set({ sha256 })
    .where(and(eq(disks.id, input.diskId), eq(disks.orgId, input.orgId))));

  await db.batch(stmts as [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return { sha256, seq, kind: plan.kind, sectorCount: plan.sectorCount };
}
```

- [ ] **Step 4: Route `applyDiskEdit` through it.** In `src/lib/disk-write.ts`, add
`userId: string | null = null` as a 4th parameter. Then replace everything from
`const sha256 = createHash('sha256').update(after).digest('hex');` down to (but not including)
the closing comment block about "THE OLD BLOB" with:

```ts
  const recorded = await recordVersion({
    orgId, diskId, headSha: disk.sha256, head: before, next: after,
    source: 'browser', userId,
    sourceFilename: disk.tosecName ?? disk.sourceFilename ?? `${diskId}.adf`,
  });
  // An edit that changes nothing (writing a file's own bytes back) is a no-op.
  const sha256 = recorded?.sha256 ?? disk.sha256;
```

Keep the "THE OLD BLOB ... IS NEVER DELETED" comment and `return { ok: true, sha256 };`. Remove
imports that are now unused (`createHash`, `blobs` if unused), and add
`import { recordVersion } from '@/lib/disk-history/store';`.

Pass `userId` at every `applyDiskEdit(` call site in `src/app` (find them with grep).
Destructure `userId` from `requireOrg()` where it isn't already.

- [ ] **Step 5: Keep the unit test honest.** In `src/lib/disk-write.test.ts`, add a
`vi.mock('@/lib/disk-history/store', () => ({ recordVersion: vi.fn() }))`. Make it resolve
`{ sha256: <the digest of the edited bytes>, seq: 1, kind: 'delta', sectorCount: 1 }`, and
change any assertion that expected `diskStore.put` / `blobs` / `entitlements` /
`disks.update` calls from `applyDiskEdit` itself into an assertion that `recordVersion` was
called once, with `source: 'browser'`, the right `headSha`, `head` and `next`, and the
`userId` passed in. The refusal tests (404, 409 mounted, 503, 400) must still assert that
**nothing** was recorded (`recordVersion` not called). Run `pnpm vitest run src/lib/disk-write.test.ts`.
Expected: PASS.

- [ ] **Step 6: Route the rename through it.** In `volume-name/route.ts`, keep the
`sha256 === disk.sha256` early return (`unchanged: true`). Then replace the
`diskStore.put`, `blobs` insert, `entitlements` insert and the `disks` sha update with:

```ts
  await recordVersion({
    orgId, diskId: id, headSha: disk.sha256, head: before, next: after,
    source: 'browser', userId, sourceFilename: `${volumeName}.adf`,
  });
  await db.update(disks)
    .set({ tosecName: `${volumeName}.adf` })
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)));
```

Get `userId` from `requireOrg()`. Leave the games title update and the device holder loop
exactly as they are. Remove now-unused imports.

- [ ] **Step 7: Run the tests.** Run `pnpm vitest run` (all green), `pnpm exec tsc --noEmit`,
then `pnpm exec playwright test e2e/disk-history.spec.ts` and the existing specs covering
edits and renames: `grep -ln "volume-name\|/files" e2e/*.spec.ts`, running each alone.
Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git status --short
git add src/lib/disk-history/store.ts src/lib/disk-write.ts src/lib/disk-write.test.ts \
        "src/app/api/disks/[id]/volume-name/route.ts" e2e/disk-history.spec.ts <each edited applyDiskEdit caller>
git commit -m "disk-history: one writer of a disk's new image; edits and renames recorded

recordVersion stores the image (blob + entitlement), the delta or
snapshot, version 0 lazily, and repoints the disk in one batch. Browser
edits and renames now go through it, so they land in history.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The device write API

**Files:**
- Create: `src/lib/device-write.ts`
- Create: `src/app/api/device/write/route.ts`
- Create: `src/app/api/device/write/close/route.ts`
- Test: `e2e/device-write.spec.ts`

**Interfaces:**
- Consumes: `recordVersion` (Task 3); `overlayTracks`, `isTrackUpload` (Task 2);
  `diskWriteSessions`, `diskWriteTracks` (Task 1).
- Produces:
  - `interface WriteQuery { diskId: string; mount: number }`
  - `type Outcome = { status: number; body: Record<string, unknown> }`
  - `async function stageTrack(device: { deviceId: string; orgId: string }, q: WriteQuery & { track: number; seq: number }, data: Uint8Array): Promise<Outcome>`
  - `async function closeSession(device: { deviceId: string; orgId: string }, q: WriteQuery & { seq: number; sha256: string }): Promise<Outcome>`
  - The HTTP contract is spec §3.3, verbatim:
    - `POST /api/device/write?disk=&mount=&track=&seq=` (body: 5,632 octets) → 200
      `{ staged: n }` | 200 `{ duplicate: true }` | 409 `not_mounted` | 409 `write_protected` |
      400 `invalid_query` / `invalid_body` | 404.
    - `POST /api/device/write/close?disk=&mount=&seq=&sha256=` → 200 `{ sha256 }` | 409
      `{ error: 'mismatch', sha256 }` | 409 `not_mounted`.

- [ ] **Step 1: Write the failing e2e** at `e2e/device-write.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskVersions, diskWriteSessions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { formatVolume } from '@/lib/adffs/format';
import { TRACK_DATA_BYTES } from '@/lib/adfmfm';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const deltaShas: string[] = [];

test.afterAll(async () => {
  for (const s of deltaShas) { try { await diskStore.remove(s); } catch { /* ignore */ } }
  await cleanupSeeded();
});

/** A signed-up org, a paired device, a writable disk with real bytes, mounted and reported. */
async function mountedWritableDisk(page: import('@playwright/test').Page,
                                   request: import('@playwright/test').APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const adf = formatVolume({ filesystem: 'FFS', volumeName: `W${runTag().slice(0, 8)}` });
  const original = sha(adf);
  await diskStore.put(original, adf);
  const { diskId } = await seedDisk(orgId, { title: `Write ${runTag()}`, diskNo: 1, sha256: original });
  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
  const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const { version } = await mounted.json();
  // The board reports what it holds before it uploads (plan 2b does the same).
  expect((await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: original, mountedDiskId: diskId, version },
  })).status()).toBe(204);
  return { orgId, deviceId, token, diskId, adf, original, mount: version as number };
}

function upload(request: import('@playwright/test').APIRequestContext, token: string,
                q: { diskId: string; mount: number; track: number; seq: number }, data: Uint8Array) {
  return request.post(
    `/api/device/write?disk=${q.diskId}&mount=${q.mount}&track=${q.track}&seq=${q.seq}`,
    { headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: Buffer.from(data) });
}

test('an upload and a close make a new version the board can download', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const written = new Uint8Array(TRACK_DATA_BYTES).fill(0x5a);

  const up = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 40, seq: 1 }, written);
  expect(up.status()).toBe(200);

  const expected = m.adf.slice(); expected.set(written, 40 * TRACK_DATA_BYTES);
  const want = sha(expected);
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${want}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  expect((await close.json()).sha256).toBe(want);

  const [disk] = await getDb().select().from(disks).where(eq(disks.id, m.diskId));
  expect(disk.sha256).toBe(want);
  const [dev] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(dev.mountedSha256).toBe(want);
  expect(dev.desiredSha256).toBe(want);

  const rows = await getDb().select().from(diskVersions)
    .where(eq(diskVersions.diskId, m.diskId)).orderBy(asc(diskVersions.seq));
  expect(rows.map((r) => [r.seq, r.source])).toEqual([[0, 'original'], [1, 'amiga']]);
  expect(rows[1].deviceId).toBe(m.deviceId);
  expect(rows[1].sectorCount).toBe(11);
  if (rows[1].kind === 'delta') deltaShas.push(rows[1].blobSha256);

  // The session is gone, and the new image is downloadable by the board.
  expect(await getDb().select().from(diskWriteSessions)
    .where(eq(diskWriteSessions.deviceId, m.deviceId))).toEqual([]);
  expect((await request.get(`/api/device/image/${want}`, { headers: authHeader(m.token) })).status()).toBe(200);
});

test('a repeated seq is accepted and changes nothing', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const a = new Uint8Array(TRACK_DATA_BYTES).fill(1);
  const b = new Uint8Array(TRACK_DATA_BYTES).fill(2);
  expect((await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 7, seq: 1 }, a)).status()).toBe(200);
  const dup = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 7, seq: 1 }, b);
  expect(dup.status()).toBe(200);
  expect((await dup.json()).duplicate).toBe(true);

  const expected = m.adf.slice(); expected.set(a, 7 * TRACK_DATA_BYTES);   // a, not b
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${sha(expected)}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(200);
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('a write-protected disk refuses uploads', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  await page.request.patch(`/api/disks/${m.diskId}`, { data: { writeProtected: true } });
  const res = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 0, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('write_protected');
});

test('an upload for a mount the board does not hold is refused', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const res = await upload(request, m.token, { diskId: m.diskId, mount: m.mount + 1, track: 0, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('not_mounted');
});

test('a short body and a bad query are 400s', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  const short = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 0, seq: 1 },
                             new Uint8Array(100));
  expect(short.status()).toBe(400);
  const bad = await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 160, seq: 1 },
                           new Uint8Array(TRACK_DATA_BYTES));
  expect(bad.status()).toBe(400);
});

test('a close whose digest disagrees: the server image wins and the board re-downloads', async ({ page, request }) => {
  const m = await mountedWritableDisk(page, request);
  await upload(request, m.token, { diskId: m.diskId, mount: m.mount, track: 3, seq: 1 },
               new Uint8Array(TRACK_DATA_BYTES).fill(9));
  const [before] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  const close = await request.post(
    `/api/device/write/close?disk=${m.diskId}&mount=${m.mount}&seq=1&sha256=${'0'.repeat(64)}`,
    { headers: authHeader(m.token) });
  expect(close.status()).toBe(409);
  const body = await close.json();
  expect(body.error).toBe('mismatch');
  const [after] = await getDb().select().from(devices).where(eq(devices.id, m.deviceId));
  expect(after.desiredVersion).toBe(before.desiredVersion + 1);
  expect(after.desiredSha256).toBe(body.sha256);
  expect(after.lastError).toContain('mismatch');
  const rows = await getDb().select().from(diskVersions).where(eq(diskVersions.diskId, m.diskId));
  for (const r of rows) if (r.kind === 'delta') deltaShas.push(r.blobSha256);
});

test('no token is refused', async ({ request }) => {
  const res = await request.post('/api/device/write?disk=x&mount=1&track=0&seq=1', { data: Buffer.alloc(5632) });
  expect([401, 404]).toContain(res.status());
  expect(res.headers()['cache-control']).toBe('no-store');
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm exec playwright test e2e/device-write.spec.ts`.
Expected: 404s from the missing routes.

- [ ] **Step 3: Implement the session rules** at `src/lib/device-write.ts`:

```ts
import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { diskWriteSessions, diskWriteTracks } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { recordVersion } from '@/lib/disk-history/store';
import { overlayTracks, isTrackUpload } from '@/lib/disk-history/version';

/**
 * A board's write session (write-back spec §3.1, §3.3). The board uploads each
 * rewritten track, then closes the session; the close turns the staged tracks
 * into one history version.
 */

export interface WriteQuery { diskId: string; mount: number }
export type Outcome = { status: number; body: Record<string, unknown> };
type Device = { deviceId: string; orgId: string };

/** 409 not_mounted unless this board holds exactly this disk at exactly this mount. */
async function holdsMount(device: Device, q: WriteQuery): Promise<boolean> {
  const rows = await getDb()
    .select({ diskId: devices.mountedDiskId, version: devices.mountedVersion })
    .from(devices)
    .where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)))
    .limit(1);
  return rows[0]?.diskId === q.diskId && rows[0]?.version === q.mount;
}

export async function stageTrack(
  device: Device, q: WriteQuery & { track: number; seq: number }, data: Uint8Array,
): Promise<Outcome> {
  if (!isTrackUpload(q.track, data)) return { status: 400, body: { error: 'invalid_body' } };
  if (!(await holdsMount(device, q))) return { status: 409, body: { error: 'not_mounted' } };

  const db = getDb();
  const disk = (await db.select({ wp: disks.writeProtected }).from(disks)
    .where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };
  if (disk.wp) return { status: 409, body: { error: 'write_protected' } };

  let session = (await db.select({ lastSeq: diskWriteSessions.lastSeq }).from(diskWriteSessions)
    .where(and(eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount)))
    .limit(1))[0];
  if (!session) {
    // A session left open under an EARLIER mount means the board lost power
    // before closing it. After a reboot the board re-downloads the head image,
    // which does not contain those tracks; applying them later would make the
    // server and the board disagree. Discarded -- the force majeure the
    // operator accepted (spec D3).
    await db.delete(diskWriteSessions).where(and(
      eq(diskWriteSessions.deviceId, device.deviceId), ne(diskWriteSessions.mount, q.mount)));
    await db.insert(diskWriteSessions).values({
      deviceId: device.deviceId, mount: q.mount, diskId: q.diskId, lastSeq: 0,
    }).onConflictDoNothing();
    session = { lastSeq: 0 };
  }
  if (q.seq <= session.lastSeq) return { status: 200, body: { duplicate: true } };

  await db.batch([
    db.insert(diskWriteTracks).values({
      deviceId: device.deviceId, mount: q.mount, track: q.track, data,
    }).onConflictDoUpdate({
      target: [diskWriteTracks.deviceId, diskWriteTracks.mount, diskWriteTracks.track],
      set: { data },
    }),
    db.update(diskWriteSessions).set({ lastSeq: q.seq }).where(and(
      eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount))),
  ]);
  return { status: 200, body: { staged: q.track } };
}

export async function closeSession(
  device: Device, q: WriteQuery & { seq: number; sha256: string },
): Promise<Outcome> {
  if (!(await holdsMount(device, q))) return { status: 409, body: { error: 'not_mounted' } };
  const db = getDb();

  const disk = (await db.select({ sha256: disks.sha256, tosecName: disks.tosecName })
    .from(disks).where(and(eq(disks.id, q.diskId), eq(disks.orgId, device.orgId))).limit(1))[0];
  if (!disk) return { status: 404, body: { error: 'not_found' } };

  const staged = await db.select({ track: diskWriteTracks.track, data: diskWriteTracks.data })
    .from(diskWriteTracks)
    .where(and(eq(diskWriteTracks.deviceId, device.deviceId), eq(diskWriteTracks.mount, q.mount)));
  if (staged.length === 0) return { status: 200, body: { sha256: disk.sha256, unchanged: true } };

  const head = await diskStore.read(disk.sha256);
  const next = overlayTracks(head, staged);
  const ent = (await db.select({ name: entitlements.sourceFilename }).from(entitlements)
    .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, disk.sha256))).limit(1))[0];
  const recorded = await recordVersion({
    orgId: device.orgId, diskId: q.diskId, headSha: disk.sha256, head, next,
    source: 'amiga', deviceId: device.deviceId,
    sourceFilename: disk.tosecName ?? ent?.name ?? `${q.diskId}.adf`,
  });
  const sha256 = recorded?.sha256 ?? disk.sha256;

  await db.delete(diskWriteSessions).where(and(
    eq(diskWriteSessions.deviceId, device.deviceId), eq(diskWriteSessions.mount, q.mount)));

  const mismatch = sha256 !== q.sha256;
  // This board already holds `sha256` -- unless the digests disagree, in which
  // case the server's image wins and the version bump makes it re-download.
  await db.update(devices).set({
    mountedSha256: mismatch ? undefined : sha256,
    desiredSha256: sha256,
    ...(mismatch ? {
      desiredVersion: sql`${devices.desiredVersion} + 1`,
      lastError: `write close mismatch: board ${q.sha256.slice(0, 12)} server ${sha256.slice(0, 12)}`,
      lastErrorAt: new Date(),
    } : {}),
  }).where(and(eq(devices.id, device.deviceId), eq(devices.orgId, device.orgId)));

  // Any OTHER board that wants this disk is now behind: point it at the new
  // image and bump it, so it re-downloads (the volume-name holder pattern).
  await db.update(devices).set({
    desiredSha256: sha256, desiredVersion: sql`${devices.desiredVersion} + 1`,
  }).where(and(
    eq(devices.orgId, device.orgId), eq(devices.desiredDiskId, q.diskId), ne(devices.id, device.deviceId)));

  if (mismatch) return { status: 409, body: { error: 'mismatch', sha256 } };
  return { status: 200, body: { sha256 } };
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
```

Remove `sha256Hex` if nothing imports it. It is there only if a route needs it.

- [ ] **Step 4: Implement the two routes.** `src/app/api/device/write/route.ts`:

```ts
import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { stageTrack } from '@/lib/device-write';

export const maxDuration = 60;

const query = z.object({
  disk: z.string().min(1).max(64),
  mount: z.coerce.number().int().nonnegative(),
  track: z.coerce.number().int().min(0).max(159),
  seq: z.coerce.number().int().positive(),
});

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) { res.headers.set('cache-control', 'no-store'); return res; }
    throw e;
  }
  const q = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) {
    return Response.json({ error: 'invalid_query', detail: z.flattenError(q.error) },
                         { status: 400, headers: NO_STORE });
  }
  const data = new Uint8Array(await request.arrayBuffer());
  const out = await stageTrack(device,
    { diskId: q.data.disk, mount: q.data.mount, track: q.data.track, seq: q.data.seq }, data);
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
```

`src/app/api/device/write/close/route.ts` has the same shape, with:

```ts
const query = z.object({
  disk: z.string().min(1).max(64),
  mount: z.coerce.number().int().nonnegative(),
  seq: z.coerce.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
// ...after parsing:
  const out = await closeSession(device,
    { diskId: q.data.disk, mount: q.data.mount, seq: q.data.seq, sha256: q.data.sha256 });
```

- [ ] **Step 5: Run and confirm it passes.** Run `pnpm exec tsc --noEmit`, then
`pnpm exec playwright test e2e/device-write.spec.ts`. Expected: all pass. If the drizzle
`bytea` custom type round-trips wrongly through neon-http (the close image differs), fix
`fromDriver` in `src/db/schema/disk-history.ts`, and say so in the report with what the
driver actually returned.

- [ ] **Step 6: Commit.**

```bash
git status --short
git add src/lib/device-write.ts src/app/api/device/write e2e/device-write.spec.ts
git commit -m "Device write API: stage tracks, close into a history version

POST /api/device/write stages a track (idempotent on seq, refused unless
the board holds this disk at this mount and it is writable); close builds
the image, records an 'amiga' version, and repoints the board without a
re-download -- or, on a digest mismatch, the server image wins and the
board re-downloads. A session left under an earlier mount is discarded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Live write-protect, the scanner rate, and the e2e teardown

**Files:**
- Modify: `src/app/api/disks/[id]/route.ts` (PATCH)
- Modify: `src/lib/tosec-sweep.ts` (`scanStatus`, the `authored_none` subquery)
- Modify: `e2e/global-teardown.ts`
- Test: `e2e/write-protect-live.spec.ts`

**Interfaces:**
- Consumes: `diskVersions` (Task 1).
- Produces: no new API. PATCH `writeProtected` now bumps `desiredVersion` for devices whose
  `desiredDiskId` is the disk.

- [ ] **Step 1: Write the failing e2e** at `e2e/write-protect-live.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
test.afterAll(cleanupSeeded);

test('flipping write-protect reaches a board holding the disk, without a new digest', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const { diskId } = await seedDisk(orgId, { title: `Wp ${runTag()}`, diskNo: 1, sha256: digest });
  const { version } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();

  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);

  const poll = await request.get(`/api/device/poll?since=${version}`, { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  const body = await poll.json();
  expect(body.version).toBe(version + 1);
  expect(body.desired.sha256).toBe(digest);          // same bytes: the board does not re-fetch
  expect(body.desired.writeProtected).toBe(false);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm exec playwright test e2e/write-protect-live.spec.ts`.
Expected: the poll holds its full 25 s and times out, or returns 204/unchanged, because
nothing bumps the version today.

- [ ] **Step 3: Bump on flip.** In the PATCH handler, after `updated.length === 0` returns 404,
add:

```ts
  // Live write-protect (write-back spec §3.5): a board holding this disk learns
  // the flag on its next poll. The digest is unchanged, so the board takes its
  // already-mounted path and applies the flag to WPROT without re-downloading
  // (device_client.c dc_handle_poll_body).
  await getDb().update(devices)
    .set({ desiredVersion: sql`${devices.desiredVersion} + 1` })
    .where(and(eq(devices.orgId, orgId), eq(devices.desiredDiskId, id)));
```

Add the imports: `devices` from `@/db/schema/devices`, and `sql`. Update the file's comment,
which currently says no device is repointed here.

- [ ] **Step 4: Run and confirm it passes.** Run `pnpm exec playwright test e2e/write-protect-live.spec.ts`
and the existing specs that PATCH `writeProtected`
(`grep -ln "writeProtected" e2e/*.spec.ts`), each alone. Expected: all pass.

- [ ] **Step 5: The scanner rate.** In `scanStatus()`'s `authored_none` subquery, wrap the
`not exists (... g.authored = false)` clause as:

```sql
          and (
            not exists (
              select 1 from disks d
              join games g on g.id = d.game_id
              where d.sha256 = b.sha256 and g.authored = false
            )
            -- A disk image that exists because someone WROTE to a disk
            -- (write-back): in no preservation set, and not a gap in the archive.
            or exists (
              select 1 from disk_versions v where v.image_sha256 = b.sha256 and v.seq > 0
            )
          )
```

Update the `authoredNone` doc comment in the interface to mention written images. Run
`pnpm exec tsc --noEmit`, then the scan spec alone (`grep -ln "admin/scan" e2e/*.spec.ts`).
Expected: pass.

- [ ] **Step 6: The e2e teardown.** In `e2e/global-teardown.ts`, **before** the `for (const row of doomed.rows)`
loop, delete the delta blobs of doomed users' disks. `deleteUserCascade` removes the
`disk_versions` rows that are the only record of them:

```ts
    // Delta blobs live only in the blob store (never a `blobs` row), and the
    // disk_versions rows naming them cascade away with the user below -- after
    // which nothing could ever find them again.
    const deltas = await db.execute<{ sha: string }>(sql`
      select distinct v.blob_sha256 as sha from disk_versions v
      join disks d on d.id = v.disk_id
      join auth."member" m on m.organization_id = d.org_id
      join auth."user" u on u.id = m.user_id
      where v.kind = 'delta' and u.email like ${TEST_EMAIL} and u.email <> ${KEEP}`);
    for (const { sha } of deltas.rows) {
      try { await diskStore.remove(sha); } catch { /* never uploaded, or already gone */ }
    }
```

Add the count to the final `console.log` line (`${deltas.rows.length} delta blobs`).

- [ ] **Step 7: Full check.** Run `pnpm vitest run`, `pnpm exec tsc --noEmit`, `pnpm lint`
(no new errors against its existing baseline), and `pnpm build`. Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git status --short
git add "src/app/api/disks/[id]/route.ts" src/lib/tosec-sweep.ts e2e/global-teardown.ts e2e/write-protect-live.spec.ts
git commit -m "Live write-protect; written images are not TOSEC misses; teardown reclaims deltas

A PATCH to writeProtected bumps every board that wants the disk, which
applies the flag without re-downloading (the digest is unchanged).
scanStatus treats a written disk's image as decided. The e2e teardown
removes delta blobs before the cascade forgets them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## After all tasks (controller)

1. After Task 1's review, apply the migration: `pnpm db:push`. Read its output, and confirm the
   three tables exist, e.g. with
   `select count(*) from information_schema.tables where table_name like 'disk_%'`, where the
   result must be 3.
2. After the final review: `pnpm vitest run`, `pnpm build`, and the **full** `pnpm e2e`, in the
   foreground on a clean environment. Report the counts. Merge only when all are green; then
   push.
3. Update HANDOFF with a new `§4g`, and the memory.
