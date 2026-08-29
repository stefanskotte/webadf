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
| `src/db/schema/devices.ts` | **Modify.** Desired-state columns; drop the `mountJobs` table |
| `src/db/schema/catalog.ts` | **Modify.** `disks.write_protected` |
| `src/lib/mount.ts` | **Create.** `setDesired`, `clearDesired`, `readDesiredVersion`, `readDesired`, `recordStatus` — all database logic, no HTTP |
| `src/app/api/devices/[id]/mount/route.ts` | **Create.** Human-facing mount (Task 3) |
| `src/app/api/devices/[id]/eject/route.ts` | **Create.** Human-facing eject (Task 3) |
| `src/app/api/disks/[id]/route.ts` | **Create.** `PATCH { writeProtected }` (Task 3) |
| `src/app/api/device/poll/route.ts` | **Create.** Long-poll (Task 4) |
| `src/app/api/device/image/[sha256]/route.ts` | **Create.** Entitlement-checked WFMF (Task 5) |
| `src/app/api/device/status/route.ts` | **Create.** Heartbeat and report (Task 6) |
| `e2e/device-helpers.ts` | **Create.** `pairDevice`, `seedDisk`, `authHeader` |
| `e2e/mount-actions.spec.ts` | **Create.** Task 3's proof |
| `e2e/device-poll.spec.ts` | **Create.** Task 4's proof |
| `e2e/device-image.spec.ts` | **Create.** Task 5's proof |
| `e2e/device-status.spec.ts` | **Create.** Task 6's proof |
| `e2e/device-protocol.spec.ts` | **Create.** The reference client driving the whole flow (Task 7) |

**Database behaviour is tested in Playwright, not Vitest.** No Vitest test in this repo opens a database connection — Vitest's process never loads `.env.local`, so `DATABASE_URL` is unset there, while `e2e/helpers.ts` loads it on import and e2e specs import `@/db` directly (see `e2e/ingest-api.spec.ts`). Vitest here covers only pure logic: the auth error contract and schema introspection.

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

`getDb()` reads `DATABASE_URL` at call time, and a bare `tsx` invocation does **not** load
`.env.local` — Next.js only does that for its own process. Prefix with `dotenv`:

```bash
pnpm exec dotenv -e .env.local -- pnpm exec tsx -e "
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

### Task 3: The mount library and the human-facing actions

**Files:**
- Create: `src/lib/mount.ts`
- Create: `src/app/api/devices/[id]/mount/route.ts`
- Create: `src/app/api/devices/[id]/eject/route.ts`
- Create: `src/app/api/disks/[id]/route.ts`
- Create: `e2e/device-helpers.ts`
- Create: `e2e/mount-actions.spec.ts`

**Interfaces:**
- Consumes: the Task 2 schema; `requireOrg` from `@/lib/session`.
- Produces:

```ts
// src/lib/mount.ts
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

// e2e/device-helpers.ts
export function pairDevice(page: Page, request: APIRequestContext, name?: string):
  Promise<{ deviceId: string; token: string }>;
export function seedDisk(orgId: string, opts: { title: string; diskNo: number; sha256: string }):
  Promise<{ gameId: string; diskId: string }>;
export function authHeader(token: string): { Authorization: string };
```

`setDesired` and `clearDesired` return the new `desiredVersion`, or `null` when the device or disk does not belong to `orgId`. **Returning `null` rather than throwing** keeps the org check and the "not found" case indistinguishable, which is what stops a route leaking whether another org's id exists.

**Two readers on purpose.** The poll loop (Task 4) ticks once a second for 25 seconds, so it must not run a three-table join 25 times per hold. `readDesiredVersion` is a single indexed read; the full `readDesired` runs only when the version has moved.

**`diskCount` is not a column.** `games` has no such field — the app derives it as `count(disks.id)::int` (`src/lib/queries.ts:17`). `readDesired` computes it with a correlated subquery. Do not add a `disk_count` column.

**Why these tests are Playwright and not Vitest.** No Vitest test in this repo touches `getDb`; every one of them is pure logic, and Vitest's process never loads `.env.local`, so `DATABASE_URL` is unset there. Database behaviour is tested in Playwright, where `e2e/helpers.ts` loads the env on import and specs import `@/db` directly — see `e2e/ingest-api.spec.ts`. `mount.ts` is entirely database logic, so it is tested through its endpoints. **Do not add a Vitest test that opens a database connection**, and do not edit `vitest.config.mts`.

- [ ] **Step 1: Write the e2e helpers**

Create `e2e/device-helpers.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Page, APIRequestContext } from '@playwright/test';
import { getDb } from '@/db';
import { blobs, disks, games, entitlements } from '@/db/schema/catalog';
import './helpers';   // side effect: loads .env.local before @/db is used

/** Pair a device against the signed-in page's org and return its bearer token. */
export async function pairDevice(page: Page, request: APIRequestContext, name = 'Test Device') {
  const pair = await page.request.post('/api/devices/pair', { data: { name } });
  if (pair.status() !== 200) throw new Error(`pair failed: ${pair.status()}`);
  const { code } = await pair.json();

  // A bare request context, not the page's — the device has no session.
  const mac = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '3.0.0', macAddress: mac },
  });
  if (reg.status() !== 200) throw new Error(`register failed: ${reg.status()}`);
  const { token, deviceId } = await reg.json();
  return { deviceId: deviceId as string, token: token as string };
}

/**
 * Insert one game + disk + blob + entitlement directly. Faster than the real
 * ingest flow and enough for protocol tests, which are not about ingest.
 */
export async function seedDisk(
  orgId: string,
  opts: { title: string; diskNo: number; sha256: string },
) {
  const db = getDb();
  const gameId = `gam_${randomUUID()}`;
  const diskId = randomUUID();

  await db.insert(blobs).values({
    sha256: opts.sha256, sizeBytes: 901120, storageKey: `adf/${opts.sha256}`,
  }).onConflictDoNothing();

  // games has NO diskCount column — it is derived. sortTitle IS NOT NULL.
  await db.insert(games).values({
    id: gameId, orgId, title: opts.title, sortTitle: opts.title.toLowerCase(),
  });

  await db.insert(disks).values({
    id: diskId, gameId, orgId, diskNo: opts.diskNo, sha256: opts.sha256,
    label: `${opts.title} (Disk ${opts.diskNo})`, sizeBytes: 901120,
  });

  await db.insert(entitlements).values({
    orgId, sha256: opts.sha256, sourceFilename: `${opts.title}-${opts.diskNo}.adf`,
  }).onConflictDoNothing();

  return { gameId, diskId };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}
```

- [ ] **Step 2: Write the failing spec**

Create `e2e/mount-actions.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function deviceRow(deviceId: string) {
  const r = await getDb().select().from(devices).where(eq(devices.id, deviceId));
  return r[0];
}

test('mount sets the desired disk and bumps the version', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const before = await deviceRow(deviceId);
  const res = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  expect(res.status()).toBe(200);
  const { version } = await res.json();

  const after = await deviceRow(deviceId);
  expect(after.desiredSha256).not.toBeNull();
  expect(after.desiredDiskNo).toBe(1);
  expect(after.desiredVersion).toBe(version);
  expect(version).toBeGreaterThan(before.desiredVersion);
});

test('mounting the same disk twice still bumps the version, so a failed mount can be retried', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const a = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  const b = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  expect(b.version).toBeGreaterThan(a.version);
});

test('eject nulls the desired disk and bumps the version', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const mounted = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();
  const res = await page.request.post(`/api/devices/${deviceId}/eject`);
  expect(res.status()).toBe(200);
  const { version } = await res.json();
  expect(version).toBeGreaterThan(mounted.version);

  const row = await deviceRow(deviceId);
  expect(row.desiredSha256).toBeNull();
  expect(row.desiredGameId).toBeNull();
  expect(row.desiredDiskNo).toBeNull();
});

test('one organization cannot mount to, or eject, another organization’s device', async ({ page, request, browser }) => {
  const { orgId: orgA } = await signUpFresh(page);
  const { diskId: diskA } = await seedDisk(orgA, { title: `A ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const { orgId: orgB } = await signUpFresh(pageB);
  const { deviceId: deviceB } = await pairDevice(pageB, request);
  const { diskId: diskB } = await seedDisk(orgB, { title: `B ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  // A aims at B's device — 404, not 403: A learns nothing about whether it exists.
  expect((await page.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskA } })).status()).toBe(404);
  expect((await page.request.post(`/api/devices/${deviceB}/eject`)).status()).toBe(404);

  // B aims its own device at A's disk — also 404.
  expect((await pageB.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskA } })).status()).toBe(404);

  // B's own disk on B's own device still works, proving the 404s were the org
  // check and not a broken route.
  expect((await pageB.request.post(`/api/devices/${deviceB}/mount`, { data: { diskId: diskB } })).status()).toBe(200);
  await ctxB.close();
});

test('an unknown device id and an unknown disk id are both plain 404s', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  expect((await page.request.post(`/api/devices/00000000-0000-4000-8000-000000000000/mount`, { data: { diskId } })).status()).toBe(404);
  expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId: '00000000-0000-4000-8000-000000000000' } })).status()).toBe(404);
});

test('the write-protect toggle updates the disk and is org-scoped', async ({ page, request, browser }) => {
  const { orgId } = await signUpFresh(page);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  // Defaults to protected — games shipped read-only.
  let row = (await getDb().select().from(disks).where(eq(disks.id, diskId)))[0];
  expect(row.writeProtected).toBe(true);

  const res = await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ id: diskId, writeProtected: false });

  row = (await getDb().select().from(disks).where(eq(disks.id, diskId)))[0];
  expect(row.writeProtected).toBe(false);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await signUpFresh(pageB);
  expect((await pageB.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: true } })).status()).toBe(404);
  await ctxB.close();
});

test('mount, eject and the write-protect toggle all reject an anonymous caller', async ({ request }) => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [path, method] of [
    [`/api/devices/${id}/mount`, 'post'],
    [`/api/devices/${id}/eject`, 'post'],
    [`/api/disks/${id}`, 'patch'],
  ] as const) {
    const res = await request[method](path, { data: { diskId: id, writeProtected: true }, maxRedirects: 0 });
    expect(res.status(), `${path} must redirect an anonymous caller`).toBe(307);
    expect(res.headers()['location'], path).toContain('/sign-in');
  }
});
```

- [ ] **Step 3: Run the spec to verify it fails**

Run: `pnpm e2e e2e/mount-actions.spec.ts`
Expected: every test FAILS with a 404 from Next — the routes do not exist yet. Confirm the failures are missing routes and not a broken helper.

- [ ] **Step 4: Write the mount library**

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

  // The version bump is in the same UPDATE as the state it describes, so a
  // poller can never observe a new version beside the old disk, or the reverse.
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
 * stay a single-column read on the primary key — never the join below.
 * Null means the device row is gone.
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
      // Derived, not stored — games has no disk_count column. Matches how
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

- [ ] **Step 5: Write the mount route**

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
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = mountBody.safeParse(body);
  if (!parsed.success) return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });

  const version = await setDesired(orgId, deviceId, parsed.data.diskId);
  // null covers unknown device, unknown disk, and either belonging to another
  // organization — deliberately indistinguishable.
  if (version === null) return Response.json({ error: 'not_found' }, { status: 404 });

  return Response.json({ version });
}
```

- [ ] **Step 6: Write the eject route**

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

- [ ] **Step 7: Write the write-protect toggle**

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
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

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

- [ ] **Step 8: Run the spec to verify it passes**

Run: `pnpm e2e e2e/mount-actions.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Confirm the proxy matcher still excludes these routes**

Read `src/proxy.ts`. Its matcher is `['/library/:path*', '/ingest/:path*', '/devices/:path*']`. None begins with `/api`, so nothing added here is covered. **Do not change the matcher.** Confirm by reading and say so in your report — the anonymous-caller test in Step 2 passes either way, because `requireOrg()` redirects too, so the test cannot catch a matcher mistake for you.

- [ ] **Step 10: Prove the org-scoping tests bite**

Apply each, run `pnpm e2e e2e/mount-actions.spec.ts`, record the failing test, revert:

1. Drop `eq(disks.orgId, orgId)` from `setDesired`'s disk lookup.
   Expected: `one organization cannot mount to, or eject, another organization's device` FAILS on the "B aims at A's disk" assertion.
2. Drop `eq(devices.orgId, orgId)` from `clearDesired`.
   Expected: the same test FAILS on the eject assertion.
3. Drop `eq(disks.orgId, orgId)` from the PATCH route.
   Expected: `the write-protect toggle updates the disk and is org-scoped` FAILS.

- [ ] **Step 11: Commit**

```bash
pnpm vitest run && pnpm e2e e2e/mount-actions.spec.ts
git add src/lib/mount.ts src/app/api/devices/ src/app/api/disks/ e2e/device-helpers.ts e2e/mount-actions.spec.ts
git commit -m "Add desired-state mount library and the human-facing mount, eject and write-protect actions"
```

---

### Task 4: `GET /api/device/poll`

**Files:**
- Create: `src/app/api/device/poll/route.ts`
- Create: `e2e/device-poll.spec.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse` (Task 1); `readDesired`, `readDesiredVersion` (Task 3); `pairDevice`, `seedDisk`, `authHeader` (Task 3).
- Produces: the endpoint.

**The constraint that binds this route hardest.** A failure must never look like an eject. `{"desired": null}` means ejected and may only be produced from a row that was actually read. Every error path returns a non-2xx — never a 200 with a null body. Spec §1 rule 1.

- [ ] **Step 1: Write the failing spec**

Create `e2e/device-poll.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('a device polling from version 0 is told what to mount', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: digest });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  const res = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.desired).toMatchObject({ sha256: digest, diskNo: 1, writeProtected: true });
  expect(body.version).toBeGreaterThan(0);
});

test('polling at the current version holds and then returns 204, so a device is never told the same thing twice', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  const first = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  const res = await request.get(`/api/device/poll?since=${first.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  expect(res.status()).toBe(204);
});

test('an eject is delivered as an explicit null desired', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const mounted = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();

  await page.request.post(`/api/devices/${deviceId}/eject`);
  const res = await request.get(`/api/device/poll?since=${mounted.version}`, { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.desired).toBeNull();
  expect(body.version).toBeGreaterThan(mounted.version);
});

test('a garbled since is treated as never having polled, not as up to date', async ({ page, request }) => {
  // Reading a bad `since` as "current" would strand the device on stale state
  // forever, which is the same class of bug as an accidental eject.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });

  for (const bad of ['abc', '-5', '']) {
    const res = await request.get(`/api/device/poll?since=${bad}`, { headers: authHeader(token) });
    expect(res.status(), `since=${JSON.stringify(bad)}`).toBe(200);
    expect((await res.json()).desired).not.toBeNull();
  }
});

test('a poll whose device has vanished is a 404, never a 200 that reads as an eject', async ({ page, request }) => {
  // THE property of spec §1 rule 1. A device told {"desired": null} ejects a
  // disk nobody asked it to eject.
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Px ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });
  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
  const state = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();

  // Hold a poll, then delete the row underneath it.
  const pending = request.get(`/api/device/poll?since=${state.version}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  await new Promise((r) => setTimeout(r, 2_000));
  await getDb().delete(devices).where(eq(devices.id, deviceId));

  const res = await pending;
  expect(res.status(), 'a vanished device must 404, never 200').toBe(404);
});

test('the poll rejects every flavour of bad credential with a bare 401', async ({ request }) => {
  const cases: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['malformed header', { Authorization: 'Basic abc' }],
    ['unknown token', authHeader(`wadf_${randomUUID()}`)],
  ];
  for (const [label, headers] of cases) {
    const res = await request.get('/api/device/poll?since=0', { headers });
    expect(res.status(), label).toBe(401);
    const body = await res.text();
    expect(body, label).not.toMatch(/token|hash|bearer|device/i);
  }
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm e2e e2e/device-poll.spec.ts`
Expected: all six FAIL — the route does not exist.

- [ ] **Step 3: Write the route**

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
  // A garbled `since` must not read as "up to date" — that would strand the
  // device on stale state forever. Treat it as never having polled.
  const from = Number.isFinite(since) && since >= 0 ? since : 0;

  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    // Cheap single-column read per tick. The three-table join runs only when
    // the version has actually moved — 25 joins per hold would be waste.
    const version = await readDesiredVersion(device.deviceId);

    // The device authenticated against this row, so it existed a moment ago.
    // If it has been deleted mid-poll that is a 404 — NEVER a 200 the device
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

- [ ] **Step 4: Run the spec to verify it passes**

Run: `pnpm e2e e2e/device-poll.spec.ts`
Expected: PASS, 6 tests. The 204 test takes ~25 s by design.

- [ ] **Step 5: Prove three of them bite**

Apply each, run the spec, record the failing test, revert:

1. Change `version > from` to `version >= from`.
   Expected: the 204 test FAILS — the device would be told the same thing forever.
2. Replace the `version === null` branch with `return Response.json({ version: 0, desired: null })`.
   Expected: `a poll whose device has vanished is a 404` FAILS. **This mutation is the exact bug the whole design exists to prevent.** If that test stays green here, it is not testing what it claims — fix it before continuing.
3. Change the `from` fallback to `const from = Number.isFinite(since) ? since : Number.MAX_SAFE_INTEGER;`.
   Expected: `a garbled since is treated as never having polled` FAILS.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm e2e e2e/device-poll.spec.ts
git add src/app/api/device/poll/ e2e/device-poll.spec.ts
git commit -m "Add GET /api/device/poll: long-poll desired state, never eject on failure"
```

---

### Task 5: `GET /api/device/image/[sha256]`

**Files:**
- Create: `src/app/api/device/image/[sha256]/route.ts`
- Create: `e2e/device-image.spec.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse`; `diskStore` from `@/lib/storage`; `encodeDisk`, `WFMF_BYTES` from `@/lib/adfmfm`; `entitlements` from `@/db/schema/catalog`.
- Produces: the endpoint.

**Read spec §6 before writing this.** The entitlement check is the boundary that keeps digest-knowledge from becoming digest-access. It checks that the *device's organization* holds an entitlement for the sha256 — not that the sha256 exists.

**No cache.** `encodeDisk` measures 9.6 ms. Encode on demand; do not add caching and do not store the result.

- [ ] **Step 1: Write the failing spec**

Create `e2e/device-image.spec.ts`. It needs a real ADF in Blob storage, so it drives the genuine ingest flow — copy the `uploadDisk` helper out of `e2e/ingest-api.spec.ts` rather than reinventing it, and read a real image from `adf-archive/` (gitignored, present locally):

```ts
import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader } from './device-helpers';

function anyRealAdf(): Buffer {
  const dir = 'adf-archive';
  const name = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.adf'));
  if (!name) throw new Error('no ADF in adf-archive/ — this spec needs one');
  return readFileSync(`${dir}/${name}`);
}
```

Mandatory behaviours. Write the bodies:

1. **A device fetches a disk its org owns.** Sign up, pair, ingest a real ADF through `/api/ingest/presign` + upload + `/api/ingest/complete`, then GET `/api/device/image/<sha256>` with the device's token. Assert **200**, `content-type: application/octet-stream`, a body of exactly **2,027,536** bytes, and that the first four bytes are `0x57 0x46 0x4d 0x46` (`'WFMF'` little-endian).
2. **A digest the org does not hold is a 404, not a 403 and not a 500.** Use a syntactically valid sha256 no entitlement covers.
3. **Cross-tenant.** Org A ingests a disk; org B's device requests that exact sha256 and gets **404**. This is the assertion that keeps the ingest oracle from becoming a download.
4. **A malformed digest is a 400.** `not-a-digest`, a 63-character hex string, and an uppercase 64-character hex string.
5. **Bad credentials are a 401** for all three flavours in Task 4's Step 1 list.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm e2e e2e/device-image.spec.ts`
Expected: all FAIL — the route does not exist. Confirm behaviour 1 fails on the missing route and not on a broken ingest helper.

- [ ] **Step 3: Write the route**

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
  // (D13), so a digest is not a secret — TOSEC publishes thousands of them.
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
    // the device's fault. 500, naming the digest for triage.
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

- [ ] **Step 4: Run the spec to verify it passes**

Run: `pnpm e2e e2e/device-image.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the entitlement check bites**

Delete `eq(entitlements.orgId, device.orgId)` from the query so any entitlement matches. Run the spec.
Expected: behaviours 2 and 3 FAIL. **Behaviour 3 is the one that matters** — it is the difference between a private library and a shared one. Record the failure, restore, re-run green.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm e2e e2e/device-image.spec.ts
git add src/app/api/device/image/ e2e/device-image.spec.ts
git commit -m "Add GET /api/device/image: entitlement-checked WFMF, encoded on demand"
```

---

### Task 6: `POST /api/device/status`

**Files:**
- Create: `src/app/api/device/status/route.ts`
- Create: `e2e/device-status.spec.ts`

**Interfaces:**
- Consumes: `requireDevice`, `deviceAuthResponse`; `recordStatus` (Task 3).
- Produces: the endpoint.

- [ ] **Step 1: Write the failing spec**

Create `e2e/device-status.spec.ts`. Mandatory behaviours — write the bodies:

1. **A report is recorded.** Pair a device, POST `{ mountedSha256: <digest>, psramFree: 6127616, rssi: -58 }`, expect **204**, and assert the `devices` row now has that `mountedSha256`, `psramFree`, `rssi`, and a fresh `lastSeenAt`.
2. **A report never changes desired state.** Mount disk 1, then report holding a *different* digest. Assert `desiredSha256` is unchanged and `desiredVersion` has not moved. A report is an observation, not an instruction.
3. **`mountedSha256: null` is a valid report** meaning "I hold nothing", accepted with 204 — and it still does not touch desired state.
4. **An error is recorded and then cleared.** Report `error: 'fetch failed'`, assert `lastError` and `lastErrorAt` are set; report again with `error: null`, assert `lastError` is null.
5. **A malformed body is a 400** — a non-hex `mountedSha256`, an `rssi` of `50` (out of the -120..0 range), and invalid JSON.
6. **Bad credentials are a 401** for all three flavours.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm e2e e2e/device-status.spec.ts`
Expected: all FAIL — the route does not exist.

- [ ] **Step 3: Write the route**

Create `src/app/api/device/status/route.ts`:

```ts
import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { recordStatus } from '@/lib/mount';

export const maxDuration = 60;

const SHA256_RE = /^[0-9a-f]{64}$/;

const statusBody = z.object({
  // null means "I am holding no disk" — an honest report, not an instruction.
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

- [ ] **Step 4: Run the spec to verify it passes**

Run: `pnpm e2e e2e/device-status.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove behaviour 2 bites**

In `recordStatus`, add `desiredSha256: s.mountedSha256` to the `.set({...})` so a report overwrites desired state. Run the spec.
Expected: `a report never changes desired state` FAILS. Restore, re-run green, record the message.

- [ ] **Step 6: Commit**

```bash
pnpm vitest run && pnpm e2e e2e/device-status.spec.ts
git add src/app/api/device/status/ e2e/device-status.spec.ts
git commit -m "Add POST /api/device/status: report actual state, never desired"
```

---

### Task 7: The reference client — the whole flow, end to end

The task that makes the plan mean something: one spec that drives a device through a complete lifecycle, proving the pieces compose.

**Files:**
- Create: `e2e/device-protocol.spec.ts`

**Interfaces:**
- Consumes: everything.
- Produces: the end-to-end proof.

- [ ] **Step 1: Write the spec**

Mandatory behaviours. Write the bodies; they are integration tests and their seeding differs from the per-task specs.

1. **A full mount cycle.** Sign up, pair, ingest a real ADF, mount it. Poll `since=0` → 200 with the right digest. GET the image → 2,027,536 bytes starting `57 46 4d 46`. POST status reporting that digest. Poll at the version just seen → **204**. Assert the `devices` row shows `mountedSha256` equal to `desiredSha256` — converged.
2. **Eject completes the cycle.** POST eject, poll → `desired: null` at a higher version. POST status with `mountedSha256: null`. Assert both desired and mounted are null.
3. **A swap delivers the second disk.** Ingest two disks of one game. Mount 1, poll, mount 2, poll at the first version → disk 2 with `diskNo: 2` and `diskCount: 2`. **Assert `diskCount` is 2, not 1** — it is a derived subquery and the easiest thing in this plan to get silently wrong.
4. **Write protection reaches the device.** PATCH a disk to `writeProtected: false`, mount it, poll, assert the payload says `false`. Then PATCH back to `true`, mount again, poll, assert `true`.
5. **Cross-tenant isolation across the whole flow.** Two orgs, each with a device and a disk. A's device polling never sees B's state, and A's device cannot fetch B's image.

- [ ] **Step 2: Run it, and watch each test fail for the right reason first**

Run: `pnpm e2e e2e/device-protocol.spec.ts`

Before making them pass, confirm each failure names the thing the test is about. A test failing on a typo in its seeding is not yet testing anything.

- [ ] **Step 3: Make them pass, then prove two of them bite**

1. In `readDesired`, change the `diskCount` subquery to the literal `sql<number>\`1\``.
   Expected: behaviour 3 FAILS on the `diskCount: 2` assertion.
2. In `readDesired`, change `writeProtected: r.writeProtected ?? true` to `writeProtected: true`.
   Expected: behaviour 4 FAILS on the `false` assertion.

- [ ] **Step 4: Run everything and commit**

```bash
pnpm vitest run && pnpm e2e && pnpm build
git add e2e/device-protocol.spec.ts
git commit -m "Prove the device protocol end to end with a reference client"
```

---

### Task 8: Close the open questions this plan answered

**Files:**
- Modify: `INTEGRATION.md`
- Modify: `docs/superpowers/specs/2026-08-23-webadf-design.md`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Mark INTEGRATION.md's open questions**

Questions 1 (which disk is mounted) and 3 (caching encoded images) are answered — the mount pointer is `GET /api/device/poll` returning the identity, with the device fetching `GET /api/device/image/<sha256>`; caching is decided against because `encodeDisk` is 9.6 ms. Question 4's `requireDevice` divergence is settled in `src/lib/device-auth.ts`. Mark each answered inline, pointing at `docs/superpowers/specs/2026-08-29-device-plane-disk-change-design.md`. Leave question 2 (write-back) open.

- [ ] **Step 2: Update the parent spec's §7**

Its `GET /api/device/poll` example still shows a presigned URL for a raw ADF and `mount_jobs` semantics. Replace the example with the desired-state shape from the new spec's §4, and add a row to the decisions table cross-referencing the new spec, matching how D15 already points at the encoder spec.

- [ ] **Step 3: Rewrite HANDOFF.md's status**

Plan 2's tasks 6–8 are superseded by this plan rather than pending; `mount_jobs` no longer exists; the MFM encoder is done; plan 3a is done and 3b (UI) is next. Remove the "MFM encoder — not started" row and the stale open questions, and add the two firmware defects from the encoder spec's §7 plus the third recorded there.

- [ ] **Step 4: Commit**

```bash
git add INTEGRATION.md docs/superpowers/specs/2026-08-23-webadf-design.md HANDOFF.md
git commit -m "Close the open questions plan 3a answered"
```

---

## Done when

- `pnpm vitest run` green — 215 currently, plus 3 from Task 1 and 5 from Task 2.
- `pnpm e2e` green — 27 currently, plus 7 (Task 3), 6 (Task 4), 5 (Task 5), 6 (Task 6) and 5 (Task 7).
- `pnpm build` clean.
- Every mutation named in Tasks 3, 4, 5, 6 and 7 was observed to fail a named test.
- A reference client can mount, fetch, report and eject with no hardware involved.
