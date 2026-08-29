# webadf — Device Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired ESP32 dongle can long-poll this app, be told which disk to mount, fetch it directly from blob storage, and report back — with the whole flow provable end to end by a reference client, no hardware required.

**Architecture:** Two trust planes meeting at the API. Humans authenticate with a Better Auth session cookie and drive everything; devices authenticate with an opaque bearer token and can reach exactly three endpoints, none of which can enumerate the library. A mount is a row in `mount_jobs`; the device discovers it by long-polling and fetches the bytes via a short-lived presigned URL embedded in the poll response.

**Tech Stack:** Next.js 16.3.2 · Drizzle 0.45 · `@neondatabase/serverless` 1.1 · better-auth 1.7.1 · `@vercel/blob` 2.8 · Vitest · Playwright


> ## ⚠️ PARTIALLY SUPERSEDED — read before executing
>
> The target hardware changed mid-plan (spec **D14–D16**, commit `2d81dd8`). It is now a
> self-designed RP2350 board in `wifi-floppy/` that emulates the floppy bus directly via
> PIO, **not** an ESP32 dongle feeding a Gotek over USB mass storage.
>
> | Tasks | Status |
> |---|---|
> | **1–4** | **DONE, reviewed clean, merged into `feat/device-plane`.** Protocol-agnostic; unaffected by the change. |
> | **5, 9, 10, 11** | **Still valid, not started.** Mount jobs, devices UI, game detail, mount-from-ingest. `INTEGRATION.md` open question #2 asks for exactly the mount-pointer mechanism Task 5 builds. |
> | **6, 7, 8** | **OBSOLETE as written.** They serve a presigned URL to a raw ADF. The device needs pre-encoded Amiga MFM in a `WFMF` container, fetched from webadf itself. Rewrite them in the successor plan, after the encoder exists. |
>
> Three pre-flight rulings still apply to Task 5: **PF-2** (`claimNextJob` must return a
> joined row: `{ id, gameId, gameTitle, diskNo, diskCount, sha256, filename, sizeBytes }`,
> org-scoped in the join as well as the WHERE) and **PF-3** (the mount endpoint
> `POST /api/devices/[id]/mount` moves from Task 10 into Task 5) and **PF-4** (Task 5's
> six mount-lifecycle test bodies are mandatory; the plan only names them).

**Spec:** `docs/superpowers/specs/2026-08-23-webadf-design.md` — §5 (data model), §7 (device protocol), D10, D13.

**Scope:** Plan 2 of 3. Plan 1 (foundation & library) is merged. Plan 3 is metadata enrichment. **Firmware is deferred to plan 4** — it needs physical hardware (a Seeed XIAO ESP32-S3). This plan's reference client stands in for it and proves the contract.

---

## Global Constraints

Every task inherits these. Several were learned the hard way in plan 1 and are not negotiable.

**Versions.** Node ≥20.9 (dev on 25.8), pnpm 10, `next@16.3.2`, `better-auth@1.7.1`, `drizzle-orm@0.45.2`, `@vercel/blob@2.8.0`, `zod@4`. Root `package.json` has `"type": "module"`.

**Next 16 API shapes.** `params`, `searchParams`, `cookies()`, `headers()` are **Promises** — await them. `PageProps<"/route">` and `RouteContext<"/api/route">` are ambient generated types — **never import them**. The route guard is `src/proxy.ts` exporting `proxy`, nodejs-only. `cacheComponents` stays off.

**Database.** Auth tables live in the `auth` Postgres schema via `pgSchema('auth')` — `drizzleAdapter`'s `schemaName` is a codegen hint only and does **not** namespace queries. `drizzle.config.ts` carries `schemaFilter: ['public','auth']`; **removing it makes `db:push` silently skip the `auth` schema while printing "Changes applied."** Migrations run via `pnpm db:generate` && `pnpm db:push` (both wrap `dotenv -e .env.local`).

**Tenancy.** `orgFilter(table, orgId, extra?)` from `@/db/scope` is the chokepoint for every catalog read; it throws on an empty org id. **Constrain joins as well as WHERE clauses** — an unscoped join condition was a real finding in plan 1.

**Blob storage.** `src/lib/storage.ts` is the only file that may import `@vercel/blob`. `presignUrl` takes the whole `issueSignedToken` result and returns `{ presignedUrl }`. A presigned URL is a **live credential**: never log it, never put it in the DOM, never include it in an error message.

**Testing.** Vitest **cannot render async Server Components** — pure logic and client components to Vitest, pages and flows to Playwright. Current baseline: **66 vitest, 21 Playwright**; both must stay green.

**Honesty rules, enforced in review.** A test whose name promises more than its assertions deliver is a defect — three were caught in plan 1. Prove a new test bites by breaking the code and watching it fail. Never ship a control that looks functional and does nothing. A non-OK HTTP response must never be destructurable into apparent success.

**Accessibility.** `--accent-amber` (`#f5822e`) is **fill-only** and fails WCAG AA as text. Amber text uses `--amber-text` (`#a8560f`); amber on the warning surface uses `#8a6207`.

**Never commit** `.env*`, `.adf`, `.dsk`, `test-results/`, `playwright-report/`.

---

## Two facts that shape this plan

**1. The device is an HTTP/1.1 client, so a silent long-poll can be cut.** Vercel emits HTTP/2 PING frames on an idle response, but HTTP/1.1 has no equivalent frame, and Vercel's own docs say intermediaries may close idle HTTP/1.1 connections — the documented remedy is to stream progress while waiting. So `/api/device/poll` **streams newline-delimited output**: a bare `\n` every few seconds as a keepalive, terminated by exactly one JSON line. The device reads lines, skips empty ones, parses the first non-empty line, and closes. That is trivial for a microcontroller and immune to idle-connection reaping. It also means the poll always returns **200** — there is no 204, because bytes are already on the wire by the time we know the answer.

**2. `isBoot` is not guaranteed.** `groupDisks` marks disk 1 as boot; a set with disks 2 and 3 and no disk 1 gets **none**. Seven games in the live database currently have zero boot disks. **No code in this plan may assume a boot disk exists** — resolve the default disk as "the `isBoot` one, else the lowest `diskNo`".

---

## File Structure

```
src/
├── db/schema/devices.ts              devices, pairing_codes, mount_jobs, invites
├── lib/
│   ├── device-token.ts               mint / hash / constant-time compare (pure)
│   ├── device-auth.ts                requireDevice() — bearer -> device row
│   ├── invites.ts                    invite code issue + redeem (D13)
│   ├── mount.ts                      queueMount / claimNextJob / settleJob
│   └── disk-select.ts                defaultDiskFor() — never assumes isBoot
├── app/api/device/                   DEVICE PLANE — bearer token only
│   ├── register/route.ts             pairing code -> device token
│   ├── poll/route.ts                 ndjson long-poll with keepalive
│   └── status/route.ts               heartbeat + job settlement
├── app/api/devices/                  HUMAN PLANE — session cookie only
│   ├── route.ts                      list devices for the org
│   ├── pair/route.ts                 mint a pairing code
│   └── [id]/mount/route.ts           queue a mount job
├── app/(app)/devices/page.tsx
├── app/(app)/games/[id]/page.tsx
├── components/devices/{device-card,pairing-panel,activity-log}.tsx
├── components/library/{disk-selector,mount-button}.tsx
└── proxy.ts                          extend matcher: /devices, /games
tools/reference-device.ts             stands in for firmware; proves the contract
e2e/{devices,mount,invite}.spec.ts
```

---

## Task 1: Invite-only sign-up (D13)

**Files:**
- Create: `src/db/schema/devices.ts` (invites table only for now), `src/lib/invites.ts`, `src/lib/invites.test.ts`, `e2e/invite.spec.ts`
- Modify: `src/db/index.ts`, `src/app/(auth)/sign-up/page.tsx`, `src/lib/auth.ts`

**Interfaces:**
- Consumes: `getDb()` from `@/db`
- Produces:
  - table `invites` from `@/db/schema/devices`
  - `issueInvite(orgId, createdByUserId): Promise<string>` — returns the plaintext code
  - `redeemInvite(code: string): Promise<{ ok: true; orgId: string } | { ok: false; reason: 'unknown' | 'used' | 'expired' }>`
  - `normalizeInviteCode(raw: string): string`

Spec D13: registration is closed so that knowing a digest cannot be exploited by a stranger. This gates the device plane, so it lands first.

- [ ] **Step 1: Write the failing unit tests**

```ts
// src/lib/invites.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeInviteCode } from './invites';

describe('normalizeInviteCode', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizeInviteCode(' ab3-4kd ')).toBe('AB34KD');
  });

  it('maps visually ambiguous characters onto the canonical alphabet', () => {
    // The alphabet excludes O/0 and I/1/L confusion; a human retyping a code
    // from a screen must not be defeated by it.
    expect(normalizeInviteCode('o0iIlL')).toBe('001111');
  });

  it('is idempotent', () => {
    const once = normalizeInviteCode('ab3-4kd');
    expect(normalizeInviteCode(once)).toBe(once);
  });

  it('leaves an already-canonical code untouched', () => {
    expect(normalizeInviteCode('XY7K2M')).toBe('XY7K2M');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/invites.test.ts`
Expected: FAIL — cannot resolve `./invites`.

- [ ] **Step 3: Add the schema**

```ts
// src/db/schema/devices.ts
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),          // normalized, uppercase
  orgId: text('org_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedByUserId: text('consumed_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('invites_org_idx').on(t.orgId)]);
```

Register it in `src/db/index.ts` alongside `catalog` and `authModule`, following the existing destructure pattern that excludes the non-table `pgSchema` object.

- [ ] **Step 4: Implement**

```ts
// src/lib/invites.ts
import { randomInt } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema/devices';

/** No O/0 or I/1/L — codes get retyped from a screen. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 8;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OQ]/g, '0')
    .replace(/[IL]/g, '1');
}

export async function issueInvite(orgId: string, createdByUserId: string): Promise<string> {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  await getDb().insert(invites).values({
    code, orgId, createdByUserId, expiresAt: new Date(Date.now() + TTL_MS),
  });
  return code;
}

export type RedeemResult =
  | { ok: true; orgId: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' };

export async function redeemInvite(raw: string): Promise<RedeemResult> {
  const code = normalizeInviteCode(raw);
  const rows = await getDb().select().from(invites).where(eq(invites.code, code)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, orgId: row.orgId };
}
```

> **Note on `normalizeInviteCode`.** It maps `O`/`Q` to `0` and `I`/`L` to `1`, but the generating alphabet contains neither `0` nor `1`. That is deliberate: normalization is a *forgiving reader*, not a generator. A code is never ambiguous on issue; a human mistyping `O` for what they saw still lands on a character the alphabet excludes, so it fails as `unknown` rather than silently matching a different invite.

- [ ] **Step 5: Run to verify the unit tests pass**

Run: `pnpm vitest run src/lib/invites.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Gate sign-up on a valid invite**

Add a required `inviteCode` field to `src/app/(auth)/sign-up/page.tsx`, labelled exactly `Invite code` so `getByLabel('Invite code')` resolves. Pass it through better-auth's `signUp.email` as an additional field, and enforce it in `src/lib/auth.ts` via `databaseHooks.user.create.before`, which must **throw** when redemption fails so no user row is created.

Mark the invite consumed in the existing `user.create.after` hook, beside the organization bootstrap — and inside that hook's existing `try/catch`, so a consumption failure cannot abort sign-up.

**Critical:** do not disturb the two-hook organization bootstrap. `signUpEmail` wraps its whole handler in `runWithTransaction`, so `user.create.after` is **queued** and runs after `session.create.before`. That ordering is load-bearing and was got wrong twice before being fixed.

- [ ] **Step 7: Update the e2e helper and add invite coverage**

`e2e/helpers.ts`'s `signUpFresh` is used by **every existing spec**. It must now mint an invite before signing up, or all 21 Playwright tests break. Add a helper that inserts an invite row directly via Drizzle (fastest, no chicken-and-egg) and have `signUpFresh` call it.

```ts
// e2e/invite.spec.ts
import { test, expect } from '@playwright/test';

test('sign-up without an invite code is rejected', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(`no-invite-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Invite code').fill('AAAAAAAA');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).not.toHaveURL(/\/library/);
});

test('an invite code cannot be used twice', async ({ page, browser }) => {
  // First use succeeds via the helper, which mints and consumes a fresh code.
  const { inviteCode } = await import('./helpers').then((m) => m.signUpFresh(page));

  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  await second.goto('/sign-up');
  await second.getByLabel('Email').fill(`reuse-${Date.now()}@example.test`);
  await second.getByLabel('Password').fill('correct-horse-battery-staple');
  await second.getByLabel('Invite code').fill(inviteCode);
  await second.getByRole('button', { name: 'Sign up' }).click();

  await expect(second.getByRole('alert')).toBeVisible();
  await expect(second).not.toHaveURL(/\/library/);
  await ctx.close();
});
```

`signUpFresh` must now return `inviteCode` alongside `email` and `password`.

- [ ] **Step 8: Migrate and verify the whole suite**

```bash
pnpm db:generate && pnpm db:push
pnpm vitest run && pnpm e2e && pnpm build
```

Expected: vitest 70/70, Playwright 23/23 (21 existing + 2 new), build green. **If any existing spec fails, the helper change is wrong — fix the helper, not the spec.**

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Close sign-up behind invites (D13)

An entitlement is granted on digest knowledge alone because the ingest
existence check is global by design. Closing registration bounds who can
exploit that to people the operator invited."
git push
```

---

## Task 2: Device, pairing and mount-job schema

**Files:**
- Modify: `src/db/schema/devices.ts`
- Create: `drizzle/` migration (generated)

**Interfaces:**
- Consumes: `invites` table from Task 1
- Produces: tables `devices`, `pairingCodes`, `mountJobs` from `@/db/schema/devices`

Column set comes from spec §5. `mount_jobs.disk_no` is singular — D10 fixed one disk in the drive at a time.

- [ ] **Step 1: Add the three tables**

```ts
// src/db/schema/devices.ts — append
import { integer, boolean } from 'drizzle-orm/pg-core';

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),   // sha-256 hex of the plaintext
  firmwareVersion: text('firmware_version'),
  macAddress: text('mac_address'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  rssi: integer('rssi'),
  psramFree: integer('psram_free'),
  mountedGameId: text('mounted_game_id'),
  mountedDiskNo: integer('mounted_disk_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('devices_org_idx').on(t.orgId)]);

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  orgId: text('org_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('pairing_codes_org_idx').on(t.orgId)]);

export const mountJobs = pgTable('mount_jobs', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  gameId: text('game_id').notNull(),
  diskNo: integer('disk_no').notNull(),
  sha256: text('sha256').notNull(),
  state: text('state').notNull().default('queued'),  // queued|claimed|done|failed
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('mount_jobs_device_state_idx').on(t.deviceId, t.state),
  index('mount_jobs_org_idx').on(t.orgId),
]);
```

- [ ] **Step 2: Generate, apply and verify against the database**

```bash
pnpm db:generate && pnpm db:push
```

Then confirm the tables really landed — `db:push` has silently skipped a schema before:

```bash
set -a; . ./.env.local; set +a
psql "$DATABASE_URL" -tAc "select table_name from information_schema.tables where table_schema='public' order by 1"
```

Expected to include `devices`, `pairing_codes`, `mount_jobs`, `invites`.

- [ ] **Step 3: Verify nothing regressed**

Run: `pnpm vitest run && pnpm build`
Expected: 70/70, build green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Add device, pairing-code and mount-job tables"
git push
```

---

## Task 3: Device tokens

**Files:**
- Create: `src/lib/device-token.ts`, `src/lib/device-token.test.ts`

**Interfaces:**
- Produces:
  - `mintDeviceToken(): { plaintext: string; hash: string }`
  - `hashDeviceToken(plaintext: string): string`
  - `tokensMatch(a: string, b: string): boolean` — constant time

Devices never touch Better Auth. This is the whole of their credential handling, so it gets its own task and real tests.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/device-token.test.ts
import { describe, it, expect } from 'vitest';
import { mintDeviceToken, hashDeviceToken, tokensMatch } from './device-token';

describe('device tokens', () => {
  it('mints a prefixed, high-entropy plaintext', () => {
    const { plaintext } = mintDeviceToken();
    expect(plaintext.startsWith('wadf_')).toBe(true);
    expect(plaintext.length).toBeGreaterThanOrEqual(40);
  });

  it('never mints the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintDeviceToken().plaintext));
    expect(seen.size).toBe(200);
  });

  it('returns a hash that matches hashing the plaintext separately', () => {
    const { plaintext, hash } = mintDeviceToken();
    expect(hashDeviceToken(plaintext)).toBe(hash);
  });

  it('produces a 64-char lowercase hex hash', () => {
    expect(hashDeviceToken('wadf_whatever')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not store the plaintext inside the hash', () => {
    const { plaintext, hash } = mintDeviceToken();
    expect(hash).not.toContain(plaintext.slice(5));
  });

  it('compares equal hashes as equal and unequal as unequal', () => {
    const a = hashDeviceToken('one');
    expect(tokensMatch(a, hashDeviceToken('one'))).toBe(true);
    expect(tokensMatch(a, hashDeviceToken('two'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths; a malformed header must not 500.
    expect(tokensMatch(hashDeviceToken('one'), 'short')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/device-token.test.ts`
Expected: FAIL — cannot resolve `./device-token`.

- [ ] **Step 3: Implement**

```ts
// src/lib/device-token.ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'wadf_';

export function hashDeviceToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function mintDeviceToken(): { plaintext: string; hash: string } {
  const plaintext = PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, hash: hashDeviceToken(plaintext) };
}

/** Constant-time comparison of two hex digests. Never throws. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/device-token.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add device token minting and constant-time comparison

Devices never touch Better Auth; this is the whole of their credential
handling. Only the sha-256 hash is ever stored."
git push
```

---

## Task 4: Pairing — mint a code, register a device

**Files:**
- Create: `src/lib/device-auth.ts`, `src/app/api/devices/pair/route.ts`, `src/app/api/device/register/route.ts`, `e2e/pairing.spec.ts`
- Modify: `src/proxy.ts` (add `/devices/:path*` to the matcher)

**Interfaces:**
- Consumes: `requireOrg()`, `mintDeviceToken`, `hashDeviceToken`, `tokensMatch`, tables from Task 2
- Produces:
  - `requireDevice(request: Request): Promise<{ deviceId: string; orgId: string }>` from `@/lib/device-auth` — throws a `Response` (401) when the bearer token is absent or unknown
  - `POST /api/devices/pair` (human) → `{ code, expiresAt }`
  - `POST /api/device/register` (device) → `{ token, deviceId, name }`, the **only** time the plaintext is ever returned

- [ ] **Step 1: Implement `requireDevice`**

```ts
// src/lib/device-auth.ts
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { hashDeviceToken, tokensMatch } from '@/lib/device-token';

export class DeviceAuthError extends Error {
  constructor() { super('device authentication failed'); }
}

export async function requireDevice(request: Request): Promise<{ deviceId: string; orgId: string }> {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new DeviceAuthError();

  const hash = hashDeviceToken(m[1]);
  const rows = await getDb()
    .select({ id: devices.id, orgId: devices.orgId, tokenHash: devices.tokenHash })
    .from(devices)
    .where(eq(devices.tokenHash, hash))
    .limit(1);

  const row = rows[0];
  // The lookup is already by hash; the constant-time compare guards against a
  // future change that widens the query.
  if (!row || !tokensMatch(row.tokenHash, hash)) throw new DeviceAuthError();
  return { deviceId: row.id, orgId: row.orgId };
}
```

- [ ] **Step 2: Implement the two routes**

`POST /api/devices/pair` — session-authenticated via `requireOrg()`. Mints a 6-character code from the same unambiguous alphabet as invites, 10-minute TTL, single use, stored in `pairing_codes`.

`POST /api/device/register` — **unauthenticated by design** (the device has no token yet). Body `{ pairingCode, firmwareVersion, macAddress }`, validated with zod. Consumes the code inside a single conditional update so two devices racing the same code cannot both win:

```ts
// the claim must be atomic — set consumed_at only if it is still null
const claimed = await db.update(pairingCodes)
  .set({ consumedAt: new Date() })
  .where(and(eq(pairingCodes.code, code), isNull(pairingCodes.consumedAt),
             gt(pairingCodes.expiresAt, new Date())))
  .returning({ orgId: pairingCodes.orgId });
if (claimed.length === 0) return Response.json({ error: 'invalid_or_used_code' }, { status: 400 });
```

Then mint a token, insert the `devices` row storing **only** `tokenHash`, and return the plaintext once.

Set `export const maxDuration = 60` on both routes.

- [ ] **Step 3: Write the failing e2e**

```ts
// e2e/pairing.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('a device can pair once with a code, and not twice', async ({ page, request }) => {
  await signUpFresh(page);

  const pair = await page.request.post('/api/devices/pair', { data: { name: 'Living Room' } });
  expect(pair.status()).toBe(200);
  const { code } = await pair.json();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);

  // The device has no session — a bare request context, not the page's.
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(reg.status()).toBe(200);
  const { token, deviceId } = await reg.json();
  expect(token).toMatch(/^wadf_/);
  expect(deviceId).toBeTruthy();

  // Same code again must fail.
  const again = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(again.status()).toBe(400);
});

test('registering with an unknown code fails', async ({ request }) => {
  const res = await request.post('/api/device/register', {
    data: { pairingCode: 'ZZZZZZ', firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:FF' },
  });
  expect(res.status()).toBe(400);
});

test('minting a pairing code requires a session', async ({ request }) => {
  const res = await request.post('/api/devices/pair', { data: { name: 'x' }, maxRedirects: 0 });
  expect(res.status()).toBe(307);
});
```

- [ ] **Step 4: Run and verify**

Run: `pnpm e2e e2e/pairing.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Confirm the plaintext token is never persisted**

```bash
set -a; . ./.env.local; set +a
psql "$DATABASE_URL" -tAc "select count(*) from devices where token_hash like 'wadf_%'"
```

Expected: `0`. Put the result in your report — a stored plaintext token would be a Critical finding.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add device pairing: mint a code, register a device

The code is claimed with a conditional update so two devices racing the
same code cannot both win. Only the token hash is stored."
git push
```

---

## Task 5: Mount jobs

**Files:**
- Create: `src/lib/disk-select.ts`, `src/lib/disk-select.test.ts`, `src/lib/mount.ts`, `src/lib/mount.test.ts`

**Interfaces:**
- Consumes: `orgFilter`, `stableId`, tables `games`/`disks`/`mountJobs`
- Produces:
  - `defaultDiskFor(disks: Array<{ diskNo: number; isBoot: boolean }>): number | null`
  - `queueMount(args: { orgId, deviceId, gameId, diskNo }): Promise<{ jobId: string }>`
  - `claimNextJob(deviceId: string): Promise<MountJobRow | null>`
  - `settleJob(args: { jobId, deviceId, state: 'done' | 'failed', error?: string }): Promise<boolean>`
    — `false` when the job is not that device's, or is not in `claimed`

- [ ] **Step 1: Write the failing disk-selection tests**

This exists because `isBoot` is **not** guaranteed — seven live games have none.

```ts
// src/lib/disk-select.test.ts
import { describe, it, expect } from 'vitest';
import { defaultDiskFor } from './disk-select';

describe('defaultDiskFor', () => {
  it('prefers the boot disk', () => {
    expect(defaultDiskFor([
      { diskNo: 1, isBoot: false }, { diskNo: 2, isBoot: true },
    ])).toBe(2);
  });

  it('falls back to the lowest disk number when nothing is marked boot', () => {
    // Real case: a set with disks 2 and 3 and no disk 1 gets no boot flag.
    expect(defaultDiskFor([
      { diskNo: 3, isBoot: false }, { diskNo: 2, isBoot: false },
    ])).toBe(2);
  });

  it('returns null for an empty set rather than guessing', () => {
    expect(defaultDiskFor([])).toBeNull();
  });

  it('is deterministic when several disks claim boot', () => {
    expect(defaultDiskFor([
      { diskNo: 2, isBoot: true }, { diskNo: 1, isBoot: true },
    ])).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/disk-select.test.ts`
Expected: FAIL — cannot resolve `./disk-select`.

- [ ] **Step 3: Implement disk selection**

```ts
// src/lib/disk-select.ts
export function defaultDiskFor(disks: Array<{ diskNo: number; isBoot: boolean }>): number | null {
  if (disks.length === 0) return null;
  const boot = disks.filter((d) => d.isBoot).map((d) => d.diskNo);
  // groupDisks does NOT guarantee exactly one boot disk: a set with disks 2
  // and 3 and no disk 1 gets none, and two disks can both parse as disk 1.
  // Lowest-numbered wins in both directions, so this is always defined.
  const pool = boot.length > 0 ? boot : disks.map((d) => d.diskNo);
  return Math.min(...pool);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/disk-select.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement the job lifecycle**

`src/lib/mount.ts`. Rules, each with a reason:

- **`queueMount`** supersedes: mark any existing `queued` job for that device `failed` with error `superseded` before inserting. D10 means one disk in the drive, so a queue depth above one is meaningless and a stale job would mount the wrong disk later.
- Every read and write is scoped by `orgId` through `orgFilter`, and `queueMount` must verify the game **and** the disk belong to the caller's org before inserting — never trust a `gameId` from the client.
- **`claimNextJob`** takes the oldest `queued` job for the device and flips it to `claimed` in a **conditional update** (`where state = 'queued'`), returning nothing if another poll won the race.
- **`settleJob`** only settles a job belonging to that `deviceId` and only from `claimed`. On `done` it also updates `devices.mountedGameId`/`mountedDiskNo`.

- [ ] **Step 6: Write the failing lifecycle tests**

```ts
// src/lib/mount.test.ts — integration against the real database
import { describe, it, expect } from 'vitest';
import { queueMount, claimNextJob, settleJob } from './mount';
// Use a helper that seeds an org, a game with two disks, and a device.
// Clean up every row you create in an afterEach.

describe('mount job lifecycle', () => {
  it('queueing supersedes an earlier queued job for the same device', async () => { /* … */ });
  it('claimNextJob returns the job once and null on the second call', async () => { /* … */ });
  it('a job cannot be claimed by a different device', async () => { /* … */ });
  it('settleJob rejects a job that belongs to another device', async () => { /* … */ });
  it('settling done updates the device mounted state', async () => { /* … */ });
  it('queueMount refuses a gameId belonging to another org', async () => { /* … */ });
});
```

Write these out fully against your implementation — the bodies are yours, the six behaviours are not optional. The last one is the tenancy assertion and matters most.

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run`
Expected: all green, including the new mount tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add mount job lifecycle and boot-disk-free default selection

defaultDiskFor never assumes a boot disk exists -- seven live games have
none. Queueing supersedes, claiming is a conditional update so two polls
cannot both win."
git push
```

---

## Task 6: `/api/device/poll` — streaming long-poll

**Files:**
- Create: `src/app/api/device/poll/route.ts`, `e2e/device-poll.spec.ts`

**Interfaces:**
- Consumes: `requireDevice`, `claimNextJob`, `diskStore.downloadUrl`
- Produces: `GET /api/device/poll` — `application/x-ndjson`

This is the heart of the plan. Read the "Two facts" section again before starting.

- [ ] **Step 1: Implement the streaming response**

```ts
// src/app/api/device/poll/route.ts
export const maxDuration = 60;

const POLL_MS = 25_000;
const KEEPALIVE_MS = 5_000;
const TICK_MS = 500;
const URL_TTL_S = 900;   // 15 minutes — ample for one 880 KB fetch

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const started = Date.now();
      let lastBeat = started;

      try {
        while (Date.now() - started < POLL_MS) {
          if (request.signal.aborted) break;

          const job = await claimNextJob(device.deviceId);
          if (job) {
            // A presigned URL is a credential: it goes in the response body and
            // nowhere else. Never log it.
            const url = await diskStore.downloadUrl(job.sha256, URL_TTL_S);
            controller.enqueue(enc.encode(JSON.stringify({
              job: job.id,
              game: job.gameTitle,
              disk: {
                n: job.diskNo, of: job.diskCount,
                name: job.filename, size: job.sizeBytes,
                sha256: job.sha256, url,
              },
              expiresAt: new Date(Date.now() + URL_TTL_S * 1000).toISOString(),
            }) + '\n'));
            controller.close();
            return;
          }

          // HTTP/1.1 has no PING frame, and intermediaries reap idle
          // connections. A bare newline keeps the socket demonstrably alive
          // and is trivial for a microcontroller to skip.
          if (Date.now() - lastBeat >= KEEPALIVE_MS) {
            controller.enqueue(enc.encode('\n'));
            lastBeat = Date.now();
          }
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
        controller.enqueue(enc.encode(JSON.stringify({ job: null }) + '\n'));
        controller.close();
      } catch (err) {
        controller.enqueue(enc.encode(JSON.stringify({ job: null, error: 'internal' }) + '\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
```

`no-transform` and `x-accel-buffering: no` matter: a buffering proxy would defeat the keepalive entirely by holding the newlines until the response ends.

- [ ] **Step 2: Write the failing e2e**

```ts
// e2e/device-poll.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh, pairDevice, seedGameWithDisks } from './helpers';

test('poll returns no work as a terminal json line, and keeps the socket alive', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const started = Date.now();
  const res = await request.get('/api/device/poll', {
    headers: { authorization: `Bearer ${token}` }, timeout: 60_000,
  });
  const body = await res.text();
  const elapsed = Date.now() - started;

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('ndjson');
  expect(elapsed).toBeGreaterThan(20_000);          // it really held the connection
  expect(body).toContain('\n');                     // keepalives were emitted
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  expect(lines).toHaveLength(1);                    // exactly one terminal line
  expect(JSON.parse(lines[0])).toEqual({ job: null });
});

test('poll delivers a queued job with a fetchable url', async ({ page, request }) => {
  await signUpFresh(page);
  const { token, deviceId } = await pairDevice(page, request);
  const { gameId } = await seedGameWithDisks(page, 2);

  await page.request.post(`/api/devices/${deviceId}/mount`, { data: { gameId, diskNo: 1 } });

  const res = await request.get('/api/device/poll', {
    headers: { authorization: `Bearer ${token}` }, timeout: 60_000,
  });
  const line = (await res.text()).split('\n').find((l) => l.trim() !== '')!;
  const payload = JSON.parse(line);

  expect(payload.job).toBeTruthy();
  expect(payload.disk.n).toBe(1);
  expect(payload.disk.of).toBe(2);

  // The whole architecture rests on this: a bare GET, no headers, no SDK.
  const bytes = await request.get(payload.disk.url);
  expect(bytes.status()).toBe(200);
  expect((await bytes.body()).length).toBe(payload.disk.size);
});

test('poll rejects an unknown token', async ({ request }) => {
  const res = await request.get('/api/device/poll', {
    headers: { authorization: 'Bearer wadf_not-a-real-token' },
  });
  expect(res.status()).toBe(401);
});

test('poll rejects a request with no authorization header', async ({ request }) => {
  const res = await request.get('/api/device/poll');
  expect(res.status()).toBe(401);
});
```

Add `pairDevice` and `seedGameWithDisks` to `e2e/helpers.ts`.

- [ ] **Step 3: Run and verify**

Run: `pnpm e2e e2e/device-poll.spec.ts`
Expected: PASS, 4 tests. The second test is the one that matters — it proves the full chain from a human clicking mount to bytes arriving over a bare HTTPS GET.

- [ ] **Step 4: Prove the tests bite**

Temporarily make `claimNextJob` always return `null`; confirm the job-delivery test **fails**. Revert and confirm the diff is clean. Report that you did this.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add streaming device long-poll

Emits newline keepalives because the device is an HTTP/1.1 client and has
no PING frame; a silent 25s hold can be reaped by intermediaries. Always
200 -- bytes are on the wire before the answer is known."
git push
```

---

## Task 7: `/api/device/status`

**Files:**
- Create: `src/app/api/device/status/route.ts`, `e2e/device-status.spec.ts`

**Interfaces:**
- Consumes: `requireDevice`, `settleJob`
- Produces: `POST /api/device/status`

- [ ] **Step 1: Implement**

```ts
// src/app/api/device/status/route.ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { requireDevice } from '@/lib/device-auth';
import { settleJob } from '@/lib/mount';

export const maxDuration = 60;

const body = z.object({
  job: z.string().optional(),
  state: z.enum(['mounted', 'failed', 'idle']),
  mountedDisk: z.number().int().positive().optional(),
  psramFree: z.number().int().nonnegative().optional(),
  rssi: z.number().int().optional(),
  error: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = body.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const b = parsed.data;

  // Heartbeat first, and unconditionally: a device with no job still calls
  // this, and lastSeenAt is what the UI's online/offline dot reads.
  await getDb().update(devices).set({
    lastSeenAt: new Date(),
    ...(b.rssi !== undefined ? { rssi: b.rssi } : {}),
    ...(b.psramFree !== undefined ? { psramFree: b.psramFree } : {}),
  }).where(eq(devices.id, device.deviceId));

  if (b.job) {
    // settleJob scopes by deviceId, so one device cannot settle another's job.
    // It returns false when the job is not this device's or is not `claimed`.
    const settled = await settleJob({
      jobId: b.job,
      deviceId: device.deviceId,
      state: b.state === 'mounted' ? 'done' : 'failed',
      error: b.error,
    });
    // 404, not 403: confirming the job exists would leak another org's job ids.
    if (!settled) return Response.json({ error: 'unknown_job' }, { status: 404 });
  }

  return Response.json({ ok: true });
}
```

Note `settleJob` returns `Promise<boolean>`, not void — Task 5's `Produces` block already says so. The boolean is what lets this route answer 404 for a job that is not this device's, without confirming whether it exists.

- [ ] **Step 2: Write the failing e2e**

Cover: heartbeat with no job updates `lastSeenAt`; settling a job flips it to `done` and updates the device's mounted state; **a device cannot settle another device's job** (expect 404 — not 403, which would confirm the job exists); unknown token gets 401.

- [ ] **Step 3: Run, verify, commit**

Run: `pnpm e2e e2e/device-status.spec.ts`
Expected: PASS, 4 tests.

```bash
git add -A
git commit -m "Add device status heartbeat and job settlement"
git push
```

---

## Task 8: Reference device client

**Files:**
- Create: `tools/reference-device.ts`, `tools/README.md`

**Interfaces:**
- Consumes: the three device endpoints
- Produces: `pnpm device --pair <CODE>` and `pnpm device --token <TOKEN>`

This stands in for firmware until plan 4, and is the artifact that proves the protocol is implementable by something that is not this codebase.

- [ ] **Step 1: Implement**

A single Node script, no dependencies beyond the standard library, deliberately written the way the firmware will be:

1. `--pair <CODE>` → POST `/api/device/register`, print the token **once**, exit.
2. `--token <TOKEN>` → loop forever: GET `/api/device/poll`, read the body **line by line**, skip empty lines, parse the first non-empty line as JSON.
3. On a job: `fetch(disk.url)` with **no headers**, verify the SHA-256 of the received bytes matches `disk.sha256`, then POST `/api/device/status` with `state: 'mounted'`.
4. On `{ job: null }`: poll again immediately.
5. Print timings — connect, first byte, download, total — because those are the numbers plan 4 needs from real hardware.

**Digest verification is not optional.** It is what proves the device receives the bytes it asked for, and it is the check the firmware will also perform.

- [ ] **Step 2: Prove the round trip by hand**

Start the dev server, sign up, mint a pairing code, pair the reference client, mount a disk from the UI, and watch the client fetch and verify it. Paste the complete terminal output into your report, with the token redacted.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Add reference device client

Stands in for firmware until plan 4 and proves the protocol is
implementable outside this codebase. Verifies the digest of every disk it
receives, as the firmware will."
git push
```

---

## Task 9: Devices UI

**Files:**
- Create: `src/app/(app)/devices/page.tsx`, `src/components/devices/{device-card,pairing-panel,activity-log}.tsx`, `src/app/api/devices/route.ts`, `e2e/devices.spec.ts`
- Modify: `src/lib/queries.ts` (add `listDevices`)

**Visual reference:** `design/Devices.dc.html` — approved and signed off. Match it. Use the existing shell tokens and `.glass-card`; invent no colours.

**Interfaces:**
- Consumes: `requireOrg`, `orgFilter`, `devices`/`mountJobs` tables
- Produces: `listDevices(orgId): Promise<DeviceListItem[]>`

- [ ] **Step 1: Query, scoped**

`listDevices` reads through `orgFilter(devices, orgId)`. If it joins `mount_jobs`, **constrain the join too** — an unscoped join condition was a real finding in plan 1.

- [ ] **Step 2: Build the page**

Online/offline from `lastSeenAt` (online = seen within 60 s). Show the currently mounted game and disk, PSRAM as a 1.44 MB bar (D10 — one image at a time), firmware version, RSSI, and the recent `mount_jobs` as an activity log. Pairing panel mints a code and shows it in the six-cell treatment from the artboard, with its countdown.

**The empty state is a real state** — a new account has no devices and must get the pairing flow, not a blank page.

- [ ] **Step 3: Write the failing e2e**

Cover: empty state offers pairing; minting shows a 6-character code; after pairing via the API the device appears with its name; a second org does **not** see the first org's device (seed real devices in both — an empty-vs-empty comparison proves nothing, which was a real finding in plan 1).

- [ ] **Step 4: Screenshot and compare**

Save `test-results/devices.png` and compare honestly against `design/Devices.dc.html`. Name what does not match.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add devices page with pairing and activity log"
git push
```

---

## Task 10: Game detail with mount and swap

**Files:**
- Create: `src/app/(app)/games/[id]/page.tsx`, `src/components/library/{disk-selector,mount-button}.tsx`, `src/app/api/devices/[id]/mount/route.ts`, `e2e/mount.spec.ts`
- Modify: `src/lib/queries.ts` (add `getGame`), `src/proxy.ts` (add `/games/:path*`)

**Visual reference:** `design/GameDetail.dc.html` — approved. Disk 1 reads `IN DRIVE`; the rest read `SWAP TO`.

**Interfaces:**
- Consumes: `requireOrg`, `orgFilter`, `defaultDiskFor`, `queueMount`, `listDevices`
- Produces: `getGame(orgId, gameId)`; `POST /api/devices/[id]/mount` with body `{ gameId, diskNo }`

The library grid and table already link here — those links currently 404.

- [ ] **Step 1: Implement `getGame`, scoped**

Returns the game with its ordered disks. Must return `null` for a game belonging to another org so the page renders a 404, **not** someone else's disk set.

- [ ] **Step 2: Build the page**

Cover, metadata, provenance, the `/ADF/<Game>/` tree preview, and the disk selector. The mount button targets the currently selected device; the default disk comes from `defaultDiskFor` — **never assume `isBoot` exists**. A game with zero disks must render something sensible rather than crashing.

`params` is a Promise — `const { id } = await props.params`.

- [ ] **Step 3: Implement the mount endpoint**

`requireOrg()`, verify the device belongs to the caller's org, verify the game and disk do too, then `queueMount`. Returns `{ jobId }`.

- [ ] **Step 4: Write the failing e2e**

Cover: the page renders a seeded game's disks; clicking a disk queues a job that the device poll then delivers with the **right `diskNo`** (this is the swap path, D10); mounting a game from **another org** returns 404; a game with no boot disk still offers a sensible default.

That third one is the tenancy assertion. Seed real data in both orgs.

- [ ] **Step 5: Screenshot, compare, commit**

Save `test-results/game-detail.png`, compare against the artboard honestly.

```bash
git add -A
git commit -m "Add game detail with disk selector, mount and swap"
git push
```

---

## Task 11: Mount from the ingest row

**Files:**
- Modify: `src/components/ingest/dropzone.tsx`, `e2e/ingest-ui.spec.ts`

Spec D9: *the common case is that you already know which game you want and you just uploaded it.* The fast path is drop → click → play, without visiting the library. The dropzone already renders a disabled `MOUNT — SOON` control; this task makes it real.

- [ ] **Step 1: Enable the control**

On a `done` or `deduped` row, the button queues a mount for the current device. It stays **disabled with an honest label** when no device is paired or none is online — never a control that looks functional and does nothing. A row whose game could not be identified (an empty title, reported as `skippedTitle`) has nothing to mount and must say so.

- [ ] **Step 2: Write the failing e2e**

Upload a disk, pair a device, click Mount on the finished row, and assert the device poll delivers that exact `sha256`. That is D9's fast path proven end to end.

Also assert the button is disabled, with a visible reason, when no device is paired.

- [ ] **Step 3: Full suite, deploy, commit**

```bash
pnpm vitest run && pnpm e2e && pnpm build
vercel deploy --prod --yes
```

Then sign in on production, pair the reference client against the production URL, and mount one disk. Put the output in your report — local success is not production success.

```bash
git add -A
git commit -m "Enable mount from the ingest row (D9 fast path)"
git push
```

---

## Self-Review

**Spec coverage.** §7 device protocol → Tasks 4, 6, 7 (all three endpoints, with the streaming keepalive replacing the spec's `204`, which HTTP/1.1 makes unsafe — flagged in "Two facts"). §5 device tables → Task 2. D10 one-disk-at-a-time → Task 5's supersede rule and Task 10's swap path. D13 invite-only → Task 1. D9 fast path → Task 11. Devices and game-detail artboards → Tasks 9, 10.

**Deliberately deferred.** §8 firmware → plan 4, needs hardware; Task 8's reference client proves the contract meanwhile. §10 enrichment → plan 3. OTA updates, `/onboarding`, and multi-device fan-out are unbuilt and unreferenced.

**Deviation from the spec, recorded.** Spec §7 says the poll returns `204` when idle. It cannot: keepalive bytes commit the response to `200` before the outcome is known. The plan returns `200` with a terminal `{"job":null}` line instead. Update spec §7 when this lands.

**A deliberate choice about Tasks 9, 10 and 11.** Those three specify behaviour, constraints
and tests but do not transcribe the component markup, which the plan format otherwise asks
for. That is intentional: `design/Devices.dc.html` and `design/GameDetail.dc.html` are
complete, operator-approved artboards, and they specify this UI better than my transcription
would. Plan 1 proved the point — every pixel-fidelity finding there (title 34px vs the
artboard's 38px, a missing nav item, a compromised shadow token) came from *my* brief
mistranscribing an artboard that was already correct. Pointing the implementer at the
artboard removes that whole error class. Everything with a failure mode that is not visual —
the queries, the tenancy scoping, the endpoints, the assertions — is specified in full.

**Known gaps to watch.**
- Task 5's mount tests are integration tests against the live database; they must clean up after themselves or they will pollute a database that already carries ~130 test orgs.
- A device whose job is `claimed` but which never reports status leaves the job stuck. No reaper is specified here — the supersede rule in `queueMount` means the next mount clears it, so it is self-limiting rather than fatal. If a reaper is wanted, it belongs with plan 3's queue work.
- `defaultDiskFor` returns `null` for an empty set; Task 10 must render that case rather than crash.
