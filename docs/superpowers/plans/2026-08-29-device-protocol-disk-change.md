# Plan 3a — Device Protocol for Disk Change

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired device can long-poll webadf, be told which disk to mount or that it has been ejected, fetch that disk as pre-encoded Amiga MFM, and report what it actually holds — with the whole flow provable end to end by a reference client, no hardware required.

**Architecture:** Desired-state reconciliation, not a job queue. `devices` carries a nullable desired disk plus a monotonic `desired_version`; the device polls with `?since=<version>`, compares what it is told against what it holds, and converges. Null desired means ejected. The image endpoint encodes on demand — `encodeDisk` measures 9.6 ms, so there is no cache.

**Tech Stack:** Next.js 16.3.2 · Drizzle 0.45 · `@neondatabase/serverless` 1.1 · better-auth 1.7.1 · `@vercel/blob` 2.8 · `adfmfm` (this repo) · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-08-29-device-plane-disk-change-design.md` — read §1 before writing any endpoint. Parent authority: `docs/superpowers/specs/2026-08-23-webadf-design.md`.

## Global Constraints

- **The mounted disk is sticky.** Only a *successful* poll carrying a definite desired state may change what the Amiga sees. Nothing in this plan may produce a response that a device could read as "eject" when the truth is "I could not reach the server". An eject is `{"desired": null}` and nothing else. Spec §1 rule 1.
- **The server states intent, never timing.** No endpoint tells the device *when* to eject. Spec §1 rule 3 — this is what leaves the firmware free to fetch before it transitions.
- **Every query is org-scoped in the statement, not merely in a `WHERE` that a later edit could drop.** A device may only ever reach its own organization's rows.
- **`write_protected` lives on `disks`** (org-scoped), **never on `blobs`** (global, content-addressed, already shared across 26 rows). Spec §3.
- **Device-facing routes authenticate by bearer token in-handler** and must never be covered by `src/proxy.ts`'s matcher. See the comment at the top of `src/app/api/device/register/route.ts`.
- **Next 16:** `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — never import them. `cacheComponents` stays off.
- **`drizzle.config.ts` must keep `schemaFilter: ['public','auth']`.** Without it `db:push` silently skips a schema while printing "Changes applied."
- **Vitest cannot render async Server Components.** Pure logic → Vitest; routes and flows → Playwright.
- **Never log a device token or a presigned URL.** Both are live credentials.
- Run `pnpm vitest run` before each commit — 215 currently pass. `pnpm e2e` is 27.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/device-auth.ts` | **Modify.** Reconcile the error contract (Task 1) |
| `src/db/schema/devices.ts` | **Modify.** Desired-state columns; drop `mountedJobs` table |
| `src/db/schema/catalog.ts` | **Modify.** `disks.write_protected` |
| `src/lib/mount.ts` | **Create.** `setDesired`, `clearDesired`, `readDesired`, `recordStatus` — all pure DB logic, no HTTP |
| `src/app/api/device/poll/route.ts` | **Create.** Long-poll |
| `src/app/api/device/image/[sha256]/route.ts` | **Create.** Entitlement-checked WFMF |
| `src/app/api/device/status/route.ts` | **Create.** Heartbeat and report |
| `src/app/api/devices/[id]/mount/route.ts` | **Create.** Human-facing mount |
| `src/app/api/devices/[id]/eject/route.ts` | **Create.** Human-facing eject |
| `src/app/api/disks/[id]/route.ts` | **Create.** `PATCH { writeProtected }` |
| `e2e/device-protocol.spec.ts` | **Create.** The reference client driving the whole flow |

---

### Task 1: Reconcile the device auth error contract

Carried from plan 2 as a deferred finding, promoted to blocking by spec §8. `requireDevice()` throws `DeviceAuthError`, but plan 2's prose said it throws `Response(401)`. Nothing consumed it until now. **Every endpoint in this plan is a consumer**, so the divergence must be settled before any of them is written — otherwise a `catch (e) { return e }` returns a 500 where a 401 belongs.

**Files:**
- Modify: `src/lib/device-auth.ts`
- Create: `src/lib/device-auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `requireDevice(request: Request): Promise<{ deviceId: string; orgId: string }>` — unchanged signature, still throws `DeviceAuthError`. New: `deviceAuthResponse(e: unknown): Response | null`, returning a 401 `Response` when `e` is a `DeviceAuthError` and `null` otherwise.

**The ruling, so the implementer does not have to make it:** keep `DeviceAuthError` as the throw. Returning a `Response` from a library function would make `requireDevice` untestable without constructing fetch plumbing, and it couples a DB helper to HTTP. Instead every route wraps its call in try/catch and converts via one shared helper. `deviceAuthResponse` returning `null` for anything else is deliberate — it forces a route to rethrow what it does not understand rather than swallowing a genuine bug as a 401.

- [ ] **Step 1: Write the failing test**

Create `src/lib/device-auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DeviceAuthError, deviceAuthResponse } from './device-auth';

describe('deviceAuthResponse', () => {
  it('converts a DeviceAuthError into a 401', async () => {
    const res = deviceAuthResponse(new DeviceAuthError());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    await expect(res!.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('returns null for any other error, so a real bug is never masked as a 401', () => {
    expect(deviceAuthResponse(new TypeError('cannot read x of undefined'))).toBeNull();
    expect(deviceAuthResponse(new Error('boom'))).toBeNull();
    expect(deviceAuthResponse('a string')).toBeNull();
    expect(deviceAuthResponse(undefined)).toBeNull();
  });

  it('does not leak the reason for the failure', async () => {
    const body = await deviceAuthResponse(new DeviceAuthError())!.json();
    expect(JSON.stringify(body)).not.toMatch(/token|hash|bearer|device/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/device-auth.test.ts`
Expected: FAIL — `deviceAuthResponse` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/device-auth.ts`:

```ts
/**
 * Convert a thrown value into the 401 a device-facing route should return.
 *
 * Returns null for anything that is not a DeviceAuthError, so a route that
 * writes `const r = deviceAuthResponse(e); if (r) return r; throw e;` cannot
 * silently turn a genuine bug into an authentication failure.
 *
 * The body carries no detail: a caller who guessed wrong learns only that
 * they guessed wrong.
 */
export function deviceAuthResponse(e: unknown): Response | null {
  if (!(e instanceof DeviceAuthError)) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/device-auth.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the null-return test bites**

Change the guard to `if (e instanceof Error === false) return null;` so any `Error` yields a 401. Run the test.
Expected: `returns null for any other error` FAILS on the `TypeError` case. Restore and re-run green. Record the observed message.

- [ ] **Step 6: Run the full suite and commit**

```bash
pnpm vitest run
git add src/lib/device-auth.ts src/lib/device-auth.test.ts
git commit -m "Settle the device auth error contract before its first consumer"
```

---

### Task 2: Schema — desired state, write protection, drop mount_jobs

**Files:**
- Modify: `src/db/schema/devices.ts`
- Modify: `src/db/schema/catalog.ts`
- Create: a Drizzle migration under `drizzle/`

**Interfaces:**
- Consumes: nothing.
- Produces: on `devices` — `desiredSha256`, `desiredGameId`, `desiredDiskNo`, `desiredSetAt` (all nullable), `desiredVersion` (integer, not null, default 0), `mountedSha256` (nullable), `lastError` (nullable), `lastErrorAt` (nullable). On `disks` — `writeProtected` (boolean, not null, default true). The `mountJobs` table and its export are removed.

**Why `desiredVersion` and not a timestamp:** the long-poll compares `since` against it, and a monotonic integer is unambiguous under clock skew and equal-millisecond updates. Spec §4.

- [ ] **Step 1: Write the failing test**

Create `src/db/schema/devices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { devices, invites, pairingCodes } from './devices';
import * as deviceSchema from './devices';
import { disks } from './catalog';

describe('devices desired-state columns', () => {
  it('carries a nullable desired disk and a monotonic version', () => {
    expect(devices.desiredSha256.notNull).toBe(false);
    expect(devices.desiredGameId.notNull).toBe(false);
    expect(devices.desiredDiskNo.notNull).toBe(false);
    expect(devices.desiredSetAt.notNull).toBe(false);
    expect(devices.desiredVersion.notNull).toBe(true);
    expect(devices.desiredVersion.hasDefault).toBe(true);
  });

  it('separates what was reported from what was asked for', () => {
    // Collapsing these would make "disk 1 mounted, disk 2 requested, device
    // last seen 4 minutes ago" unrepresentable -- exactly the state a human
    // needs when the service has been unreachable. Spec §3.
    expect(devices.mountedSha256.notNull).toBe(false);
    expect(devices.mountedGameId).toBeDefined();
    expect(devices.desiredSha256).toBeDefined();
  });

  it('has somewhere to put the reason a mount failed', () => {
    expect(devices.lastError.notNull).toBe(false);
    expect(devices.lastErrorAt.notNull).toBe(false);
  });

  it('no longer defines mount_jobs', () => {
    expect('mountJobs' in deviceSchema).toBe(false);
  });
});

describe('disks.writeProtected', () => {
  it('is not null and defaults to protected', () => {
    expect(disks.writeProtected.notNull).toBe(true);
    expect(disks.writeProtected.hasDefault).toBe(true);
    expect(disks.writeProtected.default).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/db/schema/devices.test.ts`
Expected: FAIL — `devices.desiredSha256` is undefined.

- [ ] **Step 3: Edit the devices schema**

In `src/db/schema/devices.ts`: **delete the entire `mountJobs` table declaration**, and replace the `devices` table's column list additions as follows. Keep every existing column; add these after `mountedDiskNo`:

```ts
  mountedSha256: text('mounted_sha256'),

  // Desired state. Null across all three means ejected -- there is no separate
  // "ejected" flag, because "no disk is desired" and "eject" are the same fact.
  desiredSha256: text('desired_sha256'),
  desiredGameId: text('desired_game_id'),
  desiredDiskNo: integer('desired_disk_no'),
  desiredSetAt: timestamp('desired_set_at', { withTimezone: true }),

  // Monotonic. The long-poll compares the device's `since` against this; an
  // integer is unambiguous where a timestamp is not, under clock skew or two
  // updates in the same millisecond.
  desiredVersion: integer('desired_version').notNull().default(0),

  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
```

- [ ] **Step 4: Add write protection to disks**

In `src/db/schema/catalog.ts`, add to the `disks` table after `isBoot`:

```ts
  // Org-scoped on purpose. This must never live on `blobs`, which is global and
  // content-addressed -- 26 blobs are already shared across organizations, so a
  // flag there would apply one tenant's choice to every other tenant holding
  // the same disk. Defaults to protected: games shipped read-only.
  writeProtected: boolean('write_protected').notNull().default(true),
```

`boolean` is already imported in that file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/db/schema/devices.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:push
```

Read the generated SQL before pushing. It must add the eight columns and drop `mount_jobs`. If it proposes dropping anything else, STOP and report it.

- [ ] **Step 7: Verify against the live database**

```bash
pnpm exec tsx -e "
import { getDb } from './src/db';
const r = await getDb().execute(\`
  select column_name, is_nullable, column_default from information_schema.columns
  where table_schema='public' and table_name='devices'
    and column_name like 'desired%' or (table_name='devices' and column_name in ('mounted_sha256','last_error','last_error_at'))
  order by column_name\`);
console.log(r.rows);
const t = await getDb().execute(\"select to_regclass('public.mount_jobs') as still_there\");
console.log('mount_jobs:', t.rows[0]);
const w = await getDb().execute(\"select column_name, is_nullable, column_default from information_schema.columns where table_name='disks' and column_name='write_protected'\");
console.log('disks.write_protected:', w.rows);
"
```

Expected: eight `desired*`/`mounted_sha256`/`last_error*` rows, `mount_jobs: { still_there: null }`, and `write_protected` with `is_nullable: 'NO'` and default `true`.

- [ ] **Step 8: Run the full suite and commit**

```bash
pnpm vitest run
git add src/db/schema/devices.ts src/db/schema/catalog.ts drizzle/
git commit -m "Add desired-state columns and write protection; drop mount_jobs"
```

---

### Task 3: The mount library

All the desired-state logic, with no HTTP in it, so it is testable in Vitest.

**Files:**
- Create: `src/lib/mount.ts`
- Create: `src/lib/mount.test.ts`

**Interfaces:**
- Consumes: the Task 2 schema.
- Produces:

```ts
export interface DesiredDisk {
  sha256: string; gameId: string; game: string;
  diskNo: number; diskCount: number; label: string; writeProtected: boolean;
}
export interface DesiredState { version: number; desired: DesiredDisk | null; }

export function setDesired(orgId: string, deviceId: string, diskId: string): Promise<number | null>;
export function clearDesired(orgId: string, deviceId: string): Promise<number | null>;
export function readDesiredVersion(deviceId: string): Promise<number | null>;
export function readDesired(deviceId: string): Promise<DesiredState | null>;
export function recordStatus(deviceId: string, s: {
  mountedSha256: string | null; error: string | null;
  psramFree: number | null; rssi: number | null;
}): Promise<void>;
```

`setDesired` and `clearDesired` return the new `desiredVersion`, or `null` when the device or disk does not belong to `orgId`. **Returning `null` rather than throwing** keeps the org check and the "not found" case indistinguishable to the caller, which is what stops the route leaking whether another org's device id exists.

**Two readers on purpose.** The poll loop ticks once a second for 25 seconds, so it must not
run a three-table join 25 times per hold. `readDesiredVersion` is a single indexed column
read; the full `readDesired` runs once, only when the version has actually moved.

**`diskCount` is not a column.** `games` has no such field — the rest of the app derives it
as `count(disks.id)::int` (see `src/lib/queries.ts:17`). `readDesired` therefore computes it
with a correlated subquery. Do not add a `disk_count` column.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mount.test.ts`. These run against the live database, like `invites.test.ts` does. Seed with a helper at the top of the file:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { blobs, disks, games, entitlements } from '@/db/schema/catalog';
import { setDesired, clearDesired, readDesired, readDesiredVersion, recordStatus } from './mount';

const ORG_A = `org_a_${randomUUID()}`;
const ORG_B = `org_b_${randomUUID()}`;
let deviceA: string, deviceB: string, diskA1: string, diskA2: string, diskB1: string;
const SHA_1 = 'a'.repeat(64), SHA_2 = 'b'.repeat(64);

async function seedDisk(orgId: string, gameId: string, title: string, no: number, count: number, sha: string) {
  const db = getDb();
  await db.insert(blobs).values({ sha256: sha, sizeBytes: 901120, storageKey: `adf/${sha}` }).onConflictDoNothing();
  // games has no diskCount column -- it is derived. sortTitle IS NOT NULL.
  await db.insert(games).values({
    id: gameId, orgId, title, sortTitle: title.toLowerCase(),
  }).onConflictDoNothing();
  const id = randomUUID();
  await db.insert(disks).values({
    id, gameId, orgId, diskNo: no, sha256: sha,
    label: `${title} (Disk ${no} of ${count})`, sizeBytes: 901120,
  });
  await db.insert(entitlements).values({ orgId, sha256: sha, sourceFilename: `${title}-${no}.adf` }).onConflictDoNothing();
  return id;
}

beforeAll(async () => {
  const db = getDb();
  const gameA = `gam_${randomUUID()}`, gameB = `gam_${randomUUID()}`;
  diskA1 = await seedDisk(ORG_A, gameA, 'Project-X', 1, 2, SHA_1);
  diskA2 = await seedDisk(ORG_A, gameA, 'Project-X', 2, 2, SHA_2);
  diskB1 = await seedDisk(ORG_B, gameB, 'Turrican', 1, 1, SHA_1);
  deviceA = randomUUID(); deviceB = randomUUID();
  await db.insert(devices).values([
    { id: deviceA, orgId: ORG_A, name: 'A', tokenHash: randomUUID() },
    { id: deviceB, orgId: ORG_B, name: 'B', tokenHash: randomUUID() },
  ]);
});

describe('setDesired', () => {
  it('sets the disk and bumps the version', async () => {
    const v1 = await setDesired(ORG_A, deviceA, diskA1);
    expect(v1).not.toBeNull();
    const state = await readDesired(deviceA);
    expect(state!.version).toBe(v1);
    expect(state!.desired).toMatchObject({
      sha256: SHA_1, diskNo: 1, diskCount: 2, game: 'Project-X', writeProtected: true,
    });
  });

  it('bumps the version on every change, strictly increasing', async () => {
    const a = await setDesired(ORG_A, deviceA, diskA1);
    const b = await setDesired(ORG_A, deviceA, diskA2);
    const c = await setDesired(ORG_A, deviceA, diskA1);
    expect(b!).toBeGreaterThan(a!);
    expect(c!).toBeGreaterThan(b!);
  });

  it('bumps the version even when the same disk is set twice', async () => {
    // A re-mount is a real instruction: the device may have failed the first
    // one. If the version did not move, the poll would never deliver it again.
    const a = await setDesired(ORG_A, deviceA, diskA2);
    const b = await setDesired(ORG_A, deviceA, diskA2);
    expect(b!).toBeGreaterThan(a!);
  });

  it('refuses a device belonging to another organization', async () => {
    expect(await setDesired(ORG_A, deviceB, diskA1)).toBeNull();
  });

  it('refuses a disk belonging to another organization', async () => {
    expect(await setDesired(ORG_A, deviceB, diskB1)).toBeNull();
    expect(await setDesired(ORG_B, deviceB, diskA1)).toBeNull();
  });

  it('refuses an unknown device and an unknown disk identically', async () => {
    expect(await setDesired(ORG_A, randomUUID(), diskA1)).toBeNull();
    expect(await setDesired(ORG_A, deviceA, randomUUID())).toBeNull();
  });
});

describe('clearDesired', () => {
  it('nulls the desired disk and bumps the version', async () => {
    const set = await setDesired(ORG_A, deviceA, diskA1);
    const cleared = await clearDesired(ORG_A, deviceA);
    expect(cleared!).toBeGreaterThan(set!);
    const state = await readDesired(deviceA);
    expect(state!.desired).toBeNull();
    expect(state!.version).toBe(cleared);
  });

  it('refuses a device belonging to another organization', async () => {
    expect(await clearDesired(ORG_A, deviceB)).toBeNull();
  });
});

describe('readDesiredVersion', () => {
  it('agrees with readDesired but does not join', async () => {
    const v = await setDesired(ORG_A, deviceA, diskA1);
    expect(await readDesiredVersion(deviceA)).toBe(v);
    expect((await readDesired(deviceA))!.version).toBe(v);
  });

  it('returns null for an unknown device, so the poll can 404', async () => {
    expect(await readDesiredVersion(randomUUID())).toBeNull();
  });
});

describe('readDesired', () => {
  it('returns null for an unknown device', async () => {
    expect(await readDesired(randomUUID())).toBeNull();
  });

  it('reports writeProtected from the disk row, not a constant', async () => {
    await getDb().update(disks).set({ writeProtected: false }).where(eq(disks.id, diskA2));
    await setDesired(ORG_A, deviceA, diskA2);
    expect((await readDesired(deviceA))!.desired!.writeProtected).toBe(false);
    await getDb().update(disks).set({ writeProtected: true }).where(eq(disks.id, diskA2));
  });
});

describe('recordStatus', () => {
  it('records what the device says it holds, separately from what was desired', async () => {
    await setDesired(ORG_A, deviceA, diskA1);
    await recordStatus(deviceA, { mountedSha256: SHA_2, error: null, psramFree: 6127616, rssi: -58 });
    const row = (await getDb().select().from(devices).where(eq(devices.id, deviceA)))[0];
    expect(row.mountedSha256).toBe(SHA_2);
    expect(row.desiredSha256).toBe(SHA_1);   // unchanged by a status report
    expect(row.psramFree).toBe(6127616);
    expect(row.rssi).toBe(-58);
    expect(row.lastSeenAt).not.toBeNull();
  });

  it('records an error and clears it on the next clean report', async () => {
    await recordStatus(deviceA, { mountedSha256: null, error: 'fetch failed', psramFree: null, rssi: null });
    let row = (await getDb().select().from(devices).where(eq(devices.id, deviceA)))[0];
    expect(row.lastError).toBe('fetch failed');
    expect(row.lastErrorAt).not.toBeNull();

    await recordStatus(deviceA, { mountedSha256: SHA_1, error: null, psramFree: null, rssi: null });
    row = (await getDb().select().from(devices).where(eq(devices.id, deviceA)))[0];
    expect(row.lastError).toBeNull();
  });

  it('never changes desired state', async () => {
    const before = await readDesired(deviceA);
    await recordStatus(deviceA, { mountedSha256: null, error: 'boom', psramFree: null, rssi: null });
    const after = await readDesired(deviceA);
    expect(after!.version).toBe(before!.version);
    expect(after!.desired).toEqual(before!.desired);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/mount.test.ts`
Expected: FAIL — cannot resolve `./mount`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/mount.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';

export interface DesiredDisk {
  sha256: string;
  gameId: string;
  game: string;
  diskNo: number;
  diskCount: number;
  label: string;
  writeProtected: boolean;
}

export interface DesiredState {
  version: number;
  desired: DesiredDisk | null;
}

/**
 * Point a device at a disk. Returns the new version, or null when either the
 * device or the disk is outside `orgId`.
 *
 * Null rather than a thrown "not found" on purpose: a caller cannot tell a
 * device that belongs to someone else from one that does not exist.
 */
export async function setDesired(
  orgId: string, deviceId: string, diskId: string,
): Promise<number | null> {
  const db = getDb();

  // Org-scoped in the statement. A disk id alone is not enough to name a disk.
  const rows = await db
    .select({ sha256: disks.sha256, gameId: disks.gameId, diskNo: disks.diskNo })
    .from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId)))
    .limit(1);
  const disk = rows[0];
  if (!disk) return null;

  // The version bump is part of the same UPDATE as the state it describes, so
  // a poller can never observe a new version with the old disk, or the reverse.
  const updated = await db.update(devices)
    .set({
      desiredSha256: disk.sha256,
      desiredGameId: disk.gameId,
      desiredDiskNo: disk.diskNo,
      desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ version: devices.desiredVersion });

  return updated[0]?.version ?? null;
}

/** Eject: no disk is desired. Returns the new version, or null if out of org. */
export async function clearDesired(orgId: string, deviceId: string): Promise<number | null> {
  const updated = await getDb().update(devices)
    .set({
      desiredSha256: null,
      desiredGameId: null,
      desiredDiskNo: null,
      desiredSetAt: new Date(),
      desiredVersion: sql`${devices.desiredVersion} + 1`,
    })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning({ version: devices.desiredVersion });

  return updated[0]?.version ?? null;
}

/**
 * Just the version. The poll loop calls this once a second for 25 s, so it must
 * stay a single-column read on the primary key -- never the join below.
 * Returns null when the device row is gone.
 */
export async function readDesiredVersion(deviceId: string): Promise<number | null> {
  const rows = await getDb()
    .select({ version: devices.desiredVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return rows[0]?.version ?? null;
}

/**
 * What this device should be holding. Not org-scoped: the caller is the device
 * itself, already authenticated to exactly this row by requireDevice().
 */
export async function readDesired(deviceId: string): Promise<DesiredState | null> {
  const rows = await getDb()
    .select({
      version: devices.desiredVersion,
      sha256: devices.desiredSha256,
      gameId: devices.desiredGameId,
      diskNo: devices.desiredDiskNo,
      title: games.title,
      label: disks.label,
      writeProtected: disks.writeProtected,
      // Derived, not stored -- games has no disk_count column. Matches how
      // src/lib/queries.ts:17 counts it for the library grid.
      diskCount: sql<number>`(
        select count(*)::int from disks dc
        where dc.game_id = ${devices.desiredGameId} and dc.org_id = ${devices.orgId}
      )`,
    })
    .from(devices)
    .leftJoin(games, eq(games.id, devices.desiredGameId))
    .leftJoin(disks, and(
      eq(disks.gameId, devices.desiredGameId),
      eq(disks.diskNo, devices.desiredDiskNo),
      eq(disks.orgId, devices.orgId),
    ))
    .where(eq(devices.id, deviceId))
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  if (!r.sha256 || !r.gameId || r.diskNo === null) {
    return { version: r.version, desired: null };
  }

  return {
    version: r.version,
    desired: {
      sha256: r.sha256,
      gameId: r.gameId,
      game: r.title ?? 'Unknown',
      diskNo: r.diskNo,
      diskCount: r.diskCount || 1,
      label: r.label ?? `Disk ${r.diskNo}`,
      // A disk row that has gone missing is not a licence to allow writes.
      writeProtected: r.writeProtected ?? true,
    },
  };
}

/**
 * Record what the device says it actually holds. Never touches desired state —
 * a report is an observation, not an instruction.
 */
export async function recordStatus(
  deviceId: string,
  s: { mountedSha256: string | null; error: string | null; psramFree: number | null; rssi: number | null },
): Promise<void> {
  await getDb().update(devices)
    .set({
      mountedSha256: s.mountedSha256,
      lastSeenAt: new Date(),
      psramFree: s.psramFree,
      rssi: s.rssi,
      lastError: s.error,
      lastErrorAt: s.error ? new Date() : null,
    })
    .where(eq(devices.id, deviceId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/mount.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Prove the cross-org tests bite**

Drop `eq(disks.orgId, orgId)` from `setDesired`'s disk lookup and run the test.
Expected: `refuses a disk belonging to another organization` FAILS. Restore, re-run green, record the message.

Then drop `eq(devices.orgId, orgId)` from `clearDesired` and confirm `refuses a device belonging to another organization` FAILS. Restore.

- [ ] **Step 6: Run the full suite and commit**

```bash
pnpm vitest run
git add src/lib/mount.ts src/lib/mount.test.ts
git commit -m "Add desired-state mount library, org-scoped in the statement"
```

---

### Task 4: `GET /api/device/poll`

**Files:**
- Create: `src/app/api/device/poll/route.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse` (Task 1); `readDesired` (Task 3).
- Produces: the endpoint. Response shapes are in spec §4 and repeated below.

**Long-poll shape.** Return immediately when `desiredVersion > since`. Otherwise poll the database every 1 s for up to 25 s, then `204`. `maxDuration = 60` covers the hold plus slack.

**Global constraint that binds this route hardest:** a failure must never look like an eject. `{"desired": null}` means ejected and is only ever produced from a row that was actually read. Any error path returns a non-2xx, never a 200 with a null body.

- [ ] **Step 1: Write the implementation**

Create `src/app/api/device/poll/route.ts`:

```ts
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { readDesired, readDesiredVersion } from '@/lib/mount';

// Holds up to 25 s. maxDuration covers the hold plus slack; the platform
// default would cut the connection mid-hold.
export const maxDuration = 60;

const HOLD_MS = 25_000;
const TICK_MS = 1_000;

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const sinceRaw = new URL(request.url).searchParams.get('since');
  const since = Number.parseInt(sinceRaw ?? '0', 10);
  // A garbled `since` must not be read as "up to date" -- that would strand the
  // device on stale state forever. Treat it as never having polled.
  const from = Number.isFinite(since) && since >= 0 ? since : 0;

  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    // Cheap single-column read per tick. The three-table join runs once, only
    // when the version has actually moved -- 25 joins per hold would be waste.
    const version = await readDesiredVersion(device.deviceId);

    // The device authenticated against this row, so it existed a moment ago. If
    // it has been deleted mid-poll, that is a 404 -- NEVER a 200 the device
    // could read as an eject instruction. Spec §1 rule 1.
    if (version === null) return Response.json({ error: 'device_not_found' }, { status: 404 });

    if (version > from) {
      const state = await readDesired(device.deviceId);
      if (!state) return Response.json({ error: 'device_not_found' }, { status: 404 });
      return Response.json({ version: state.version, desired: state.desired });
    }
    if (Date.now() >= deadline) return new Response(null, { status: 204 });
    if (request.signal.aborted) return new Response(null, { status: 499 });
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
```

- [ ] **Step 2: Commit**

The endpoint's behaviour is proven end to end in Task 8, which is where its tests live — a route handler cannot be meaningfully unit-tested in Vitest here (the constraint on async Server Components applies to routes needing a live request too).

```bash
pnpm vitest run
git add src/app/api/device/poll/route.ts
git commit -m "Add GET /api/device/poll: long-poll desired state by version"
```

---

### Task 5: `GET /api/device/image/[sha256]`

**Files:**
- Create: `src/app/api/device/image/[sha256]/route.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse`; `diskStore.read` from `@/lib/storage`; `encodeDisk` from `@/lib/adfmfm`; `entitlements` from `@/db/schema/catalog`.
- Produces: the endpoint.

**Read spec §6 before writing this.** The entitlement check is the boundary that keeps digest-knowledge from becoming digest-access. It checks that the *device's organization* holds an entitlement for the sha256 — not that the sha256 exists.

**No cache.** `encodeDisk` measures 9.6 ms. Encode on demand; do not add caching, and do not store the result.

- [ ] **Step 1: Write the implementation**

Create `src/app/api/device/image/[sha256]/route.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { entitlements } from '@/db/schema/catalog';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { encodeDisk, WFMF_BYTES } from '@/lib/adfmfm';

// Fetch 880 KB from Blob, encode (~10 ms), stream 2,027,536 bytes out.
export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ sha256: string }> },
) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { sha256 } = await ctx.params;
  if (!SHA256_RE.test(sha256)) {
    return Response.json({ error: 'bad_digest' }, { status: 400 });
  }

  // THE boundary. /api/ingest/check is a deliberate global existence oracle
  // (D13), so a digest is not a secret -- TOSEC publishes thousands of them.
  // Serving bytes on digest knowledge alone would turn that accepted risk into
  // a live one. The device's own org must hold the entitlement.
  const owned = await getDb()
    .select({ sha256: entitlements.sha256 })
    .from(entitlements)
    .where(and(eq(entitlements.orgId, device.orgId), eq(entitlements.sha256, sha256)))
    .limit(1);

  // 404, not 403: a caller learns nothing about whether the blob exists.
  if (owned.length === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  let adf: Uint8Array;
  try {
    adf = await diskStore.read(sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  let wfmf: Uint8Array;
  try {
    wfmf = encodeDisk(adf);
  } catch (e) {
    // A stored blob that will not encode is our bug or a corrupt object, not
    // the device's fault. 500, and the message names the digest for triage.
    return Response.json(
      { error: 'encode_failed', sha256, detail: (e as Error).message },
      { status: 500 },
    );
  }

  return new Response(wfmf as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(WFMF_BYTES),
      'cache-control': 'no-store',
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
pnpm vitest run
git add src/app/api/device/image/
git commit -m "Add GET /api/device/image: entitlement-checked WFMF, encoded on demand"
```

---

### Task 6: `POST /api/device/status`

**Files:**
- Create: `src/app/api/device/status/route.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse`; `recordStatus` (Task 3).
- Produces: the endpoint.

- [ ] **Step 1: Write the implementation**

Create `src/app/api/device/status/route.ts`:

```ts
import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { recordStatus } from '@/lib/mount';

export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

const statusBody = z.object({
  // null means "I am holding no disk" -- an honest report, not an instruction.
  mountedSha256: z.string().regex(SHA256_RE).nullable(),
  error: z.string().max(500).nullable().optional().default(null),
  psramFree: z.number().int().nonnegative().nullable().optional().default(null),
  rssi: z.number().int().min(-120).max(0).nullable().optional().default(null),
});

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const body = await readJsonBody(request);
  if (body === null) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const parsed = statusBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  await recordStatus(device.deviceId, {
    mountedSha256: parsed.data.mountedSha256,
    error: parsed.data.error,
    psramFree: parsed.data.psramFree,
    rssi: parsed.data.rssi,
  });

  return new Response(null, { status: 204 });
}
```

- [ ] **Step 2: Commit**

```bash
pnpm vitest run
git add src/app/api/device/status/
git commit -m "Add POST /api/device/status: report actual state, never desired"
```

---

### Task 7: Human-facing mount, eject, and the write-protect toggle

**Files:**
- Create: `src/app/api/devices/[id]/mount/route.ts`
- Create: `src/app/api/devices/[id]/eject/route.ts`
- Create: `src/app/api/disks/[id]/route.ts`

**Interfaces:**
- Consumes: `requireOrg` from `@/lib/session`; `setDesired`, `clearDesired` (Task 3).
- Produces: the three endpoints.

All three are session-authenticated, org-scoped, and return `404` — never `403` — when the target is outside the caller's organization, so an id from another tenant is indistinguishable from one that does not exist.

- [ ] **Step 1: Write the mount route**

Create `src/app/api/devices/[id]/mount/route.ts`:

```ts
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { setDesired } from '@/lib/mount';

export const maxDuration = 60;

const mountBody = z.object({ diskId: z.string().min(1).max(64) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }

  const parsed = mountBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });

  const version = await setDesired(orgId, deviceId, parsed.data.diskId);
  // null covers unknown device, unknown disk, and either belonging to another
  // organization -- deliberately indistinguishable.
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
```

- [ ] **Step 2: Write the eject route**

Create `src/app/api/devices/[id]/eject/route.ts`:

```ts
import { requireOrg } from '@/lib/session';
import { clearDesired } from '@/lib/mount';

export const maxDuration = 60;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id: deviceId } = await ctx.params;

  const version = await clearDesired(orgId, deviceId);
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
```

- [ ] **Step 3: Write the write-protect toggle**

Create `src/app/api/disks/[id]/route.ts`:

```ts
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';

export const maxDuration = 60;

const patchBody = z.object({ writeProtected: z.boolean() });

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }

  const parsed = patchBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });

  // Org-scoped in the statement, not in a WHERE a later edit could drop.
  const updated = await getDb().update(disks)
    .set({ writeProtected: parsed.data.writeProtected })
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .returning({ id: disks.id, writeProtected: disks.writeProtected });

  if (updated.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(updated[0]);
}
```

- [ ] **Step 4: Confirm the proxy matcher still excludes the device plane**

Read `src/proxy.ts`. Its matcher is `['/library/:path*', '/ingest/:path*', '/devices/:path*']`. None of these begin with `/api`, so no route added in this plan is covered. **Do not change the matcher.** Confirm by reading, and say so in your report.

- [ ] **Step 5: Commit**

```bash
pnpm vitest run
git add src/app/api/devices/ src/app/api/disks/
git commit -m "Add human-facing mount, eject and write-protect endpoints"
```

---

### Task 8: The reference client — prove the whole flow

The task that makes this plan mean something. A Playwright spec that pairs a device, drives it through mount, fetch, report, and eject, and asserts every state.

**Files:**
- Create: `e2e/device-protocol.spec.ts`

**Interfaces:**
- Consumes: everything.
- Produces: the end-to-end proof.

**These behaviours are mandatory.** Write the bodies yourself — they are integration tests against a live database and dev server, and the seeding they need does not exist yet.

1. **A full mount cycle.** Sign up, pair a device, ingest a real ADF, mount disk 1 to the device. Poll with `since=0` and get a 200 whose `desired.sha256` matches, with `writeProtected: true`. Fetch `/api/device/image/<sha256>` and assert the body is exactly 2,027,536 bytes and starts with the four bytes `57 46 4d 46` (`'WFMF'` little-endian). POST status reporting that sha256. Poll again with the version just seen and get a **204**, proving the device is not told to do the same thing twice.
2. **Eject.** POST `/api/devices/<id>/eject`, poll, and get a 200 whose `desired` is exactly `null` with a higher version.
3. **A disk swap bumps the version and delivers the new disk.** Mount disk 1, poll, mount disk 2, poll with the first version, and get disk 2.
4. **Re-mounting the same disk still delivers.** Mount disk 1, poll, mount disk 1 again, poll with the version just seen, and get a 200 — not a 204. A failed mount must be retryable.
5. **The image endpoint refuses a digest the org does not hold.** Fetch a syntactically valid sha256 that no entitlement covers and assert **404** (not 403, not 500).
6. **Cross-tenant isolation.** Two organizations, each with a device. Org A cannot mount org B's disk (404), cannot eject org B's device (404), and A's device polling never sees B's state.
7. **An unauthenticated or wrongly-authenticated device gets 401** from all three device endpoints — no bearer header, a malformed header, and a well-formed but unknown token. Assert the body carries no detail about why.
8. **The write-protect toggle reaches the poll payload.** PATCH a disk to `writeProtected: false`, mount it, poll, and assert the payload says `false`.
9. **A status report never changes desired state.** Mount disk 1, report holding disk 2, then poll from version 0 and confirm the desired disk is still disk 1.
10. **A failure never looks like an eject — spec §1 rule 1, the plan's most important property.** Mount disk 1 so a disk *is* desired. Start a poll with `since` set to the current version so it holds, and **without awaiting it**, delete the device row. Await the poll. It must be a **404** — never a 200 whose `desired` is `null`, which the device would act on by ejecting a disk nobody asked it to eject. Then assert the same for the auth failures in behaviour 7: none of the three returns a 200 body at all. The whole design rests on the device only ever ejecting when explicitly told to, so this is the behaviour to get right even if others are cut.

- [ ] **Step 1: Write the spec**

Follow `e2e/pairing.spec.ts` for pairing and `e2e/ingest-api.spec.ts` for driving the API with `request` fixtures and for ingesting a real ADF. Use `signUpFresh` from `e2e/helpers.ts`.

- [ ] **Step 2: Run it and watch every test fail for the right reason first**

Run: `pnpm e2e e2e/device-protocol.spec.ts`

Before making them pass, confirm each failure message names the thing the test is about. A test that fails because of a typo in the seeding is not yet testing anything.

- [ ] **Step 3: Make them pass, then prove three of them bite**

Apply each mutation, run the spec, record which test fails, and revert:

1. In `src/app/api/device/image/[sha256]/route.ts`, delete the `eq(entitlements.orgId, device.orgId)` term so any entitlement matches.
   Expected: behaviour 5 and the image half of behaviour 6 FAIL.
2. In `src/lib/mount.ts`, change `desiredVersion: sql\`${devices.desiredVersion} + 1\`` to leave the version unchanged.
   Expected: behaviours 3 and 4 FAIL.
3. In `src/app/api/device/poll/route.ts`, change `version > from` to `>=`.
   Expected: the 204 assertion in behaviour 1 FAILS — the device would be told the same thing forever.
4. In `src/app/api/device/poll/route.ts`, change the `version === null` branch to `return Response.json({ version: 0, desired: null })`.
   Expected: behaviour 10 FAILS. This mutation is the exact bug the whole design exists to prevent — a device that cannot be found being told, in a well-formed 200, that it holds nothing. If behaviour 10 stays green here, it is not testing what it claims and must be fixed before the task is complete.

If any mutation leaves the suite green, that behaviour is not tested. Report it and fix the test.

- [ ] **Step 4: Run everything and commit**

```bash
pnpm vitest run && pnpm e2e && pnpm build
git add e2e/device-protocol.spec.ts
git commit -m "Prove the device protocol end to end with a reference client"
```

---

### Task 9: Update the handoff and the spec's open questions

**Files:**
- Modify: `HANDOFF.md`
- Modify: `INTEGRATION.md`
- Modify: `docs/superpowers/specs/2026-08-23-webadf-design.md`

- [ ] **Step 1: Close the open questions this plan answered**

In `INTEGRATION.md`, open questions 1 and 3 are now answered — the mount pointer exists (`GET /api/device/poll` returns the identity; the device fetches `GET /api/device/image/<sha256>`), and caching is decided (none needed; `encodeDisk` is 9.6 ms). Mark each answered inline with a pointer to `docs/superpowers/specs/2026-08-29-device-plane-disk-change-design.md`. Leave questions 2 (write-back) and 4 open — question 4, `requireDevice`, is answered, so mark it answered too, pointing at `src/lib/device-auth.ts`'s `deviceAuthResponse`.

- [ ] **Step 2: Update the parent spec's §7**

The device protocol section still describes `mount_jobs` semantics and a presigned URL in the poll body. Replace its `GET /api/device/poll` example with the desired-state shape from the new spec's §4, and add a line to the decisions table cross-referencing the new spec, matching how D15 already points at the encoder spec.

- [ ] **Step 3: Rewrite the handoff's status**

Update `HANDOFF.md`: plan 2's tasks 6–8 are superseded by this plan rather than pending; `mount_jobs` no longer exists; the MFM encoder is done; plan 3a is done and 3b (UI) is next. Remove the "MFM encoder — not started" row and the stale open questions.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md INTEGRATION.md docs/superpowers/specs/2026-08-23-webadf-design.md
git commit -m "Close the open questions plan 3a answered"
```

---

## Done when

- `pnpm vitest run` green — 215 currently, plus roughly 21 new from Tasks 1–3.
- `pnpm e2e` green — 27 currently, plus 10 new behaviours from Task 8.
- `pnpm build` clean.
- Every mutation in Task 8 Step 3 was observed to fail a named test.
- A reference client can mount, fetch, report and eject with no hardware involved.
