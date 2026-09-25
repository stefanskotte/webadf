# NFC tap-to-mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tag tapped on the wifi-floppy's Si512 reader mounts the disk whose id the tag carries,
from the board's own library. Claude can write a disk id onto a tag with one command.

**Architecture:**
- **Server:** two bearer-authenticated device endpoints (`/api/device/tap`, `/api/device/tap-write`),
  a write request that rides the existing long poll on an `nfcAck` cursor, and an operator CLI
  (`pnpm nfc:write`).
- **Firmware:** a step-wise reader state machine on core0, sharing the OLED's I2C budget; a mailbox
  to core1, which does the networking; and a transport "interrupted" hook, so a tap cuts a held poll
  short.

**Tech Stack:** Next.js (this repo's version: read `node_modules/next/dist/docs/` before touching
route APIs), Drizzle/Neon Postgres, vitest, Playwright; RP2350 C firmware (pico-sdk), with host
tests in `wifi-floppy/firmware/test/`.

**Spec:** `docs/superpowers/specs/2026-09-25-nfc-tap-to-mount-design.md`, including the
2026-09-25 amendment (poll interruption, `nfcAck` cursor). Read it before any task.

## Global Constraints

- The disk id pattern is exactly `^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
  (36 chars; `stableId`).
- **The org always comes from `requireDevice(request)`**, never from a request body or a tag. A
  foreign disk id and an unknown one get identical answers.
- Tag format v1: MIFARE Classic 1K, sector 1, blocks 4–6; marker `WFDK`, version `0x01`, length
  `36`; CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no xorout), big-endian, over
  the marker through the id's last byte. Key A `FF FF FF FF FF FF`. **Block 7 (the trailer) is
  never written.**
- Si512 on I2C1 at **0x28**. Reader init is the vendor's `PCD_SI512_TypeA_Init`, **Initiator
  (ControlReg = 0x10) first**.
- Tap rate limit: 1 per second per device. Write request lifetime: 2 minutes.
- **Every firmware `nfc_step()` does at most 4 register operations.** A register read is one
  operation (a write-address plus a read); a register write is one.
- **Never block core0.** Nothing in `nfc_reader.c` sleeps.
- **Migrations are applied with guarded `ADD COLUMN IF NOT EXISTS` SQL, never `pnpm db:push`.**
  It has offered to truncate `disk_versions` before.
- **E2E:** port 3100, a dev server you start yourself and log to a file, **never in parallel with
  another e2e run** (every run's teardown deletes all `@example.test` users on the one live DB).
  Split runs into invocations under ~9 minutes. Grep the output for "failed".
- **Never `pkill`/`killall` by pattern. Never `git stash`.**
- `nfc_probe.c` (branch `nfc-identify`) is NOT on this branch and must not be added.
- Firmware version for this feature: `FIRMWARE_SEMVER` **1.3.0**.

## Review Focus

- **A tag left lying on the reader** must mount once, not repeatedly. That covers the firmware
  debounce (Task 9 test `same_tag_held_reports_once`) and the server's `already` path (Task 2).
- **A tap during a held poll** must not wait for the hold to end (Task 7 test
  `poll_interrupted_returns_without_backoff`; Task 11 bench).
- **A cancelled or expired write request** must disarm the board, not leave it writing the next
  tag forever (Task 2 `nfcWriteForPoll` expiry/cancel cases; Task 7 `nfc_write_cancel_disarms`).
- **A write report for an old sequence number**, from a board that armed before a newer request,
  must not be recorded as the newer request's result (Task 2 `shouldStoreWriteResult`).
- **A reader that vanishes mid-transaction** (loose lead) must drop to `ABSENT` without a partial
  event reaching core1 as a real tap (Task 9 `chip_vanishes_mid_read`).

---

## File structure

**Server**
- `src/db/schema/devices.ts`: nine new columns (modify)
- `drizzle/0025_nfc_tap.sql`: guarded additive migration (create)
- `src/lib/nfc/rules.ts`: pure decisions: id pattern, tap decision, poll payload, result acceptance
  (create)
- `src/lib/nfc/rules.test.ts` (create)
- `src/lib/nfc/store.ts`: the DB functions the routes and the CLI call (create)
- `src/app/api/device/tap/route.ts` + `route.test.ts` (create)
- `src/app/api/device/tap-write/route.ts` + `route.test.ts` (create)
- `src/lib/mount.ts`: `readPollTick` gains `nfcWriteSeq` (modify)
- `src/app/api/device/poll/route.ts`: `nfcAck` param, `nfcWrite` payload (modify)
- `src/app/api/device/status/route.ts` + the status recorder: `nfcReader` (modify)
- `src/lib/device-limits.ts` + its test: the poll body's worst case includes `nfcWrite` (modify)
- `src/lib/nfc/resolve.ts` + `resolve.test.ts`: the CLI's disk-query resolver (create)
- `scripts/nfc-write.ts`, and `package.json` script `nfc:write` (create/modify)
- `e2e/nfc-tap.spec.ts` (create)

**Firmware** (`wifi-floppy/firmware/`)
- `src/nfc_tag.c/.h`: tag codec + CRC (pure; create)
- `src/nfc_reader.c/.h`: the Si512 state machine behind an injected bus (pure; create)
- `test/test_nfc_tag.c`, `test/test_nfc_reader.c` + `test/si512_fake.c/.h` (create)
- `src/transport.h`: `interrupted` hook + `TRANSPORT_INTERRUPTED`; `src/transport_tls.c`: checks
  it; `test/transport_fake.c/.h`: can simulate it (modify)
- `src/device_client.c/.h`: poll `nfcAck`, `nfcWrite` parsing, interruptible poll, `dc_tap`,
  `dc_tap_write_report`, `nfcReader` in status; `test/test_device_client.c` (modify)
- `src/main.c`: core0 step + mailboxes, core1 handling, OLED lines (modify)
- `src/nfc_bus_i2c.c/.h`: the real I2C1 bus for the reader (device-only; create)
- `CMakeLists.txt`: sources, version 1.3.0; `test/run.sh`: device-only exclusion (modify)

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/db/schema/devices.ts` (after `firmwareInstructionAck`, line ~90)
- Create: `drizzle/0025_nfc_tap.sql`

**Interfaces:**
- Produces: the `devices` columns `nfcReader`, `nfcWriteSeq`, `nfcWriteDiskId`,
  `nfcWriteExpiresAt`, `nfcWriteResultSeq`, `nfcWriteResult`, `nfcWriteResultUid`, `lastTapAt`,
  `lastTapOutcome`.

- [ ] **Step 1: Add the columns to the Drizzle schema**

```ts
  // NFC tap-to-mount (spec 2026-09-25). 'present' | 'absent' as the board last
  // reported; NULL = a board that has never said (older firmware).
  nfcReader: text('nfc_reader'),
  // The write request (spec §5.3): a cursor the board echoes as ?nfcAck=,
  // never a flag -- a cancel and a retry are both just the next seq.
  nfcWriteSeq: integer('nfc_write_seq').notNull().default(0),
  nfcWriteDiskId: text('nfc_write_disk_id'),
  nfcWriteExpiresAt: timestamp('nfc_write_expires_at', { withTimezone: true }),
  nfcWriteResultSeq: integer('nfc_write_result_seq'),
  nfcWriteResult: text('nfc_write_result'),
  nfcWriteResultUid: text('nfc_write_result_uid'),
  lastTapAt: timestamp('last_tap_at', { withTimezone: true }),
  lastTapOutcome: text('last_tap_outcome'),
```

Import `timestamp` if the file doesn't already.

- [ ] **Step 2: Write the guarded migration**

`drizzle/0025_nfc_tap.sql`:
```sql
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_reader" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_seq" integer DEFAULT 0 NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_disk_id" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_expires_at" timestamp with time zone;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result_seq" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result_uid" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_tap_at" timestamp with time zone;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_tap_outcome" text;
```

**Do not run `pnpm db:generate` or `db:push`.** This database has no `__drizzle_migrations`
table (HANDOFF §3al); the file is the record. **Do not apply it yourself either.** The controller
applies it to production (`psql "$DATABASE_URL" -f drizzle/0025_nfc_tap.sql`) before any e2e run.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm tsc --noEmit -p .` Expected: no new errors.
```bash
git add src/db/schema/devices.ts drizzle/0025_nfc_tap.sql
git commit -m "db: devices gain NFC reader, write-request and last-tap columns"
```

---

### Task 2: Pure rules

**Files:**
- Create: `src/lib/nfc/rules.ts`, `src/lib/nfc/rules.test.ts`

**Interfaces:**
- Produces:
  - `DISK_ID_RE: RegExp`, `TAP_MIN_INTERVAL_MS = 1000`, `NFC_WRITE_TTL_MS = 120_000`
  - `type TapOutcome = 'mounting' | 'already' | 'not_found' | 'too_long' | 'ignored'`
  - `decideTap(row: { desiredDiskId: string | null; lastTapAt: Date | null }, diskId: string, now: Date): 'ignored' | 'already' | 'mount'`
  - `nfcWriteForPoll(row: { nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null }, ack: number, now: Date): { seq: number; diskId: string | null } | null`
  - `shouldStoreWriteResult(row: { nfcWriteSeq: number; nfcWriteResultSeq: number | null }, reportSeq: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  DISK_ID_RE, decideTap, nfcWriteForPoll, shouldStoreWriteResult, NFC_WRITE_TTL_MS,
} from './rules';

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const ID2 = 'ffffffff-0000-5000-9000-000000000000';
const t = (ms: number) => new Date(1_790_000_000_000 + ms);

describe('DISK_ID_RE', () => {
  it('accepts a stableId', () => expect(DISK_ID_RE.test(ID)).toBe(true));
  it.each(['', ID.toUpperCase(), ID.slice(1), `${ID}x`, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    "'; drop table disks; --"])('refuses %j', (s) => expect(DISK_ID_RE.test(s)).toBe(false));
});

describe('decideTap', () => {
  it('mounts a different disk', () =>
    expect(decideTap({ desiredDiskId: ID2, lastTapAt: null }, ID, t(0))).toBe('mount'));
  it('mounts into an empty drive', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(5000))).toBe('mount'));
  it('is a no-op for the disk already desired', () =>
    expect(decideTap({ desiredDiskId: ID, lastTapAt: null }, ID, t(0))).toBe('already'));
  it('ignores a tap within 1 s of the last', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(999))).toBe('ignored'));
  it('accepts a tap exactly 1 s later', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(1000))).toBe('mount'));
});

describe('nfcWriteForPoll', () => {
  const live = { nfcWriteSeq: 3, nfcWriteDiskId: ID, nfcWriteExpiresAt: t(NFC_WRITE_TTL_MS), nfcWriteResultSeq: null };
  it('offers a live request the board has not acked', () =>
    expect(nfcWriteForPoll(live, 2, t(0))).toEqual({ seq: 3, diskId: ID }));
  it('says nothing once the board has acked this seq', () =>
    expect(nfcWriteForPoll(live, 3, t(0))).toBeNull());
  it('says nothing to a board AHEAD of the server (restore): no wake loop', () =>
    expect(nfcWriteForPoll(live, 9, t(0))).toBeNull());
  it('turns an expired request into a disarm', () =>
    expect(nfcWriteForPoll(live, 2, t(NFC_WRITE_TTL_MS + 1))).toEqual({ seq: 3, diskId: null }));
  it('turns a cancelled request (no disk) into a disarm', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteDiskId: null }, 2, t(0))).toEqual({ seq: 3, diskId: null }));
  it('turns an answered request into a disarm', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteResultSeq: 3 }, 2, t(0))).toEqual({ seq: 3, diskId: null }));
  it('says nothing when there has never been a request', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteSeq: 0, nfcWriteDiskId: null }, 0, t(0))).toBeNull());
});

describe('shouldStoreWriteResult', () => {
  it('stores the first result for the current seq', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: null }, 3)).toBe(true));
  it('refuses a stale seq', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 4, nfcWriteResultSeq: null }, 3)).toBe(false));
  it('refuses a duplicate', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: 3 }, 3)).toBe(false));
  it('refuses a seq from the future', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: null }, 4)).toBe(false));
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run src/lib/nfc/rules.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * NFC tap-to-mount's decisions, pure (spec 2026-09-25 §5). The routes and the
 * CLI do the I/O; everything that decides lives here so it can be tested
 * without a database.
 */

/** The shape stableId() produces (src/lib/ingest.ts). Every disk insert uses
 *  it (checked 2026-09-25); a new creation path that does not must widen this. */
export const DISK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TAP_MIN_INTERVAL_MS = 1000;
export const NFC_WRITE_TTL_MS = 120_000;

export type TapOutcome = 'mounting' | 'already' | 'not_found' | 'too_long' | 'ignored';

/** D2: a different disk swaps, the desired one is a no-op, and a burst is ignored. */
export function decideTap(
  row: { desiredDiskId: string | null; lastTapAt: Date | null },
  diskId: string, now: Date,
): 'ignored' | 'already' | 'mount' {
  if (row.lastTapAt && now.getTime() - row.lastTapAt.getTime() < TAP_MIN_INTERVAL_MS) return 'ignored';
  if (row.desiredDiskId === diskId) return 'already';
  return 'mount';
}

/**
 * What the poll tells the board about writing, given the cursor it sent.
 * null = nothing to say (up to date, ahead of us, or never asked). A request
 * that is cancelled, expired or already answered is still delivered -- as
 * diskId null, "disarm" -- so the board's cursor catches up and the hold
 * does not keep releasing forever.
 */
export function nfcWriteForPoll(
  row: { nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null },
  ack: number, now: Date,
): { seq: number; diskId: string | null } | null {
  if (row.nfcWriteSeq <= ack) return null;
  const live = row.nfcWriteDiskId !== null
    && row.nfcWriteExpiresAt !== null && now.getTime() <= row.nfcWriteExpiresAt.getTime()
    && row.nfcWriteResultSeq !== row.nfcWriteSeq;
  return { seq: row.nfcWriteSeq, diskId: live ? row.nfcWriteDiskId : null };
}

/** Only the first answer to the CURRENT request counts. */
export function shouldStoreWriteResult(
  row: { nfcWriteSeq: number; nfcWriteResultSeq: number | null }, reportSeq: number,
): boolean {
  return reportSeq === row.nfcWriteSeq && row.nfcWriteResultSeq !== reportSeq;
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run src/lib/nfc/rules.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nfc/rules.ts src/lib/nfc/rules.test.ts
git commit -m "nfc: the tap, poll-payload and write-result rules, pure and tested"
```

---

### Task 3: `POST /api/device/tap`

**Files:**
- Create: `src/lib/nfc/store.ts` (only `tapDevice` in this task)
- Create: `src/app/api/device/tap/route.ts`, `src/app/api/device/tap/route.test.ts`

**Interfaces:**
- Consumes: `DISK_ID_RE`, `decideTap`, `TapOutcome` (Task 2); `setDesired` (`src/lib/mount.ts`);
  `requireDevice`, `deviceAuthResponse` (`src/lib/device-auth.ts`).
- Produces: `tapDevice(deviceId: string, orgId: string, diskId: string, now: Date): Promise<{ outcome: TapOutcome; title?: string }>`

- [ ] **Step 1: Write the failing route test** (the store is mocked; DB behaviour is Task 8's e2e)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireDevice = vi.fn(async () => ({ deviceId: 'dev-1', orgId: 'org-1' }));
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));
const tapDevice = vi.fn(async () => ({ outcome: 'mounting', title: 'Turrican II' }));
vi.mock('@/lib/nfc/store', () => ({ tapDevice: (...a: unknown[]) => tapDevice(...(a as [])) }));

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const post = (body: unknown) => new Request('http://test/api/device/tap', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

describe('POST /api/device/tap', () => {
  it('passes the token org, never a body org, to the store', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ diskId: ID, orgId: 'org-EVIL' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'mounting', title: 'Turrican II' });
    expect(tapDevice).toHaveBeenCalledWith('dev-1', 'org-1', ID, expect.any(Date));
  });
  it.each([{}, { diskId: 'nope' }, { diskId: ID.toUpperCase() }, null])(
    'refuses a malformed body %j with 400 before the store', async (body) => {
      const { POST } = await import('./route');
      expect((await POST(post(body))).status).toBe(400);
      expect(tapDevice).not.toHaveBeenCalled();
    });
  it('answers not_found as a 200 outcome, never a 404', async () => {
    tapDevice.mockResolvedValueOnce({ outcome: 'not_found' } as never);
    const { POST } = await import('./route');
    const res = await POST(post({ diskId: ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'not_found' });
  });
});
```

- [ ] **Step 2: Run it and see it fail.** Run: `pnpm vitest run src/app/api/device/tap` Expected: FAIL (no route).

- [ ] **Step 3: Implement the store function**

`src/lib/nfc/store.ts`:
```ts
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { setDesired } from '@/lib/mount';
import { decideTap, type TapOutcome } from '@/lib/nfc/rules';

/**
 * One tap, end to end (spec §5.2). The org is the caller's -- the device's
 * token -- and setDesired scopes the disk to it, so a foreign id and an
 * unknown one both come back not_found (D4).
 */
export async function tapDevice(
  deviceId: string, orgId: string, diskId: string, now: Date,
): Promise<{ outcome: TapOutcome; title?: string }> {
  const db = getDb();
  const [row] = await db.select({ desiredDiskId: devices.desiredDiskId, lastTapAt: devices.lastTapAt })
    .from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!row) return { outcome: 'not_found' };

  const decision = decideTap(row, diskId, now);
  // An ignored tap is NOT recorded: recording it would move lastTapAt and let a
  // steady stream of taps hold the limit open forever.
  if (decision === 'ignored') return { outcome: 'ignored' };

  let outcome: TapOutcome = 'already';
  if (decision === 'mount') {
    const r = await setDesired(orgId, deviceId, diskId);
    outcome = r.ok ? 'mounting' : r.reason === 'track_too_long' ? 'too_long' : 'not_found';
  }
  await db.update(devices).set({ lastTapAt: now, lastTapOutcome: outcome })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));

  if (outcome !== 'mounting' && outcome !== 'already') return { outcome };
  const [t] = await db.select({ title: games.title }).from(disks)
    .innerJoin(games, eq(games.id, disks.gameId))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return t ? { outcome, title: t.title } : { outcome };
}
```

- [ ] **Step 4: Implement the route**

`src/app/api/device/tap/route.ts`:
```ts
import { z } from 'zod';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { tapDevice } from '@/lib/nfc/store';
import { DISK_ID_RE } from '@/lib/nfc/rules';

export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store' };
const body = z.object({ diskId: z.string().regex(DISK_ID_RE) });

/** A tag read on the board (spec 2026-09-25 §5.2). Always 200 with an outcome:
 *  a 404 for a disk would tell a foreign id from an unknown one (D4). */
export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  const result = await tapDevice(device.deviceId, device.orgId, parsed.data.diskId, new Date());
  return Response.json(result, { headers: NO_STORE });
}
```

- [ ] **Step 5: Run the tests and see them pass.** Run: `pnpm vitest run src/app/api/device/tap` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nfc/store.ts src/app/api/device/tap
git commit -m "device: POST /api/device/tap mounts a tag's disk from the board's own library"
```

---

### Task 4: The write request rides the poll, and status carries `nfcReader`

**Files:**
- Modify: `src/lib/mount.ts` (`PollTick` + `readPollTick`, line ~142)
- Modify: `src/app/api/device/poll/route.ts`
- Modify: `src/app/api/device/status/route.ts`, plus whatever function it passes the parsed body
  to for the DB write (follow `trackMaxBytes` through the file: `nfcReader` goes exactly where
  `trackMaxBytes` goes)
- Modify: `src/lib/nfc/store.ts` (add `readNfcWriteRow`)
- Modify: `src/lib/device-limits.ts` and its test (the worst-case poll body)

**Interfaces:**
- Consumes: `nfcWriteForPoll` (Task 2).
- Produces:
  - `PollTick.nfcWriteSeq: number`
  - `readNfcWriteRow(deviceId: string): Promise<{ nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null; title: string | null } | null>`
  - Poll JSON key `nfcWrite: { seq: number; diskId: string | null; title: string | null }`, present
    only when `nfcWriteForPoll` returns non-null
  - Status body key `nfcReader: 'present' | 'absent'` (optional)

- [ ] **Step 1: Failing test for the body-size bound.** In `src/lib/device-limits.test.ts`, extend
  the worst-case poll body the test builds with
  `nfcWrite: { seq: 4294967295, diskId: '<36 chars>', title: '<DC_TITLE_MAX chars of a 4-byte UTF-8 char>' }`,
  following exactly how that test builds `update`. Run
  `pnpm vitest run src/lib/device-limits.test.ts`. If it still passes, the 1536-byte board buffer
  already has room: record that in a comment and move on. If it fails, bound the title the same way
  `readDesired` bounds `game` (`DC_TITLE_MAX`) and re-run.

- [ ] **Step 2: `readPollTick` gains the cursor.** Add `nfcWriteSeq: devices.nfcWriteSeq` to its
  select and `nfcWriteSeq: number` to `PollTick`.

- [ ] **Step 3: `readNfcWriteRow` in `store.ts`**

```ts
/** The write-request columns plus the disk's title, for the poll payload. */
export async function readNfcWriteRow(deviceId: string) {
  const [r] = await getDb().select({
    nfcWriteSeq: devices.nfcWriteSeq, nfcWriteDiskId: devices.nfcWriteDiskId,
    nfcWriteExpiresAt: devices.nfcWriteExpiresAt, nfcWriteResultSeq: devices.nfcWriteResultSeq,
    title: games.title,
  }).from(devices)
    .leftJoin(disks, and(eq(disks.id, devices.nfcWriteDiskId), eq(disks.orgId, devices.orgId)))
    .leftJoin(games, eq(games.id, disks.gameId))
    .where(eq(devices.id, deviceId)).limit(1);
  return r ?? null;
}
```

- [ ] **Step 4: The poll route.**
  - Parse `nfcAck` exactly as `since` is parsed (digits only, safe integer, else 0).
  - In the loop, after `firmwareMoved`, add `const nfcMoved = tick.nfcWriteSeq > nfcAck;` and add
    `|| nfcMoved` to the wake condition.
  - When building the response:
    ```ts
    const nfcRow = nfcMoved ? await readNfcWriteRow(device.deviceId) : null;
    const nfc = nfcRow ? nfcWriteForPoll(nfcRow, nfcAck, new Date()) : null;
    // ...in the JSON, after instructionVersion, before update:
    ...(nfc ? { nfcWrite: { seq: nfc.seq, diskId: nfc.diskId, title: nfc.diskId ? nfcRow!.title : null } } : {}),
    ```
  - Add a comment explaining that `nfcAck` is the board's cursor, like `since`, and that a
    cancelled or expired request is still delivered (as a disarm), so the cursor catches up and
    the hold can't collapse into an immediate-return loop.

- [ ] **Step 5: Status.** Add `nfcReader: z.enum(['present', 'absent']).optional().catch(undefined)`
  to `statusBody`, and pass it through to the DB update as `nfcReader` wherever `trackMaxBytes`
  goes. An absent key leaves the column alone, the same rule as the other optional fields there.

- [ ] **Step 6: Run the suite.** `pnpm vitest run` Expected: all green. `pnpm build`: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mount.ts src/lib/nfc/store.ts src/app/api/device/poll/route.ts src/app/api/device/status src/lib/device-limits.ts src/lib/device-limits.test.ts
git commit -m "device: the poll carries an NFC write request on an nfcAck cursor; status reports the reader"
```

---

### Task 5: `POST /api/device/tap-write` and the CLI's store functions

**Files:**
- Create: `src/app/api/device/tap-write/route.ts`, `route.test.ts`
- Modify: `src/lib/nfc/store.ts` (add `storeWriteResult`, `requestNfcWrite`, `cancelNfcWrite`,
  `readWriteResult`)

**Interfaces:**
- Consumes: `shouldStoreWriteResult`, `NFC_WRITE_TTL_MS` (Task 2).
- Produces:
  - `storeWriteResult(deviceId: string, r: { seq: number; ok: boolean; uid: string; reason?: string }): Promise<boolean>`
  - `requestNfcWrite(orgId: string, deviceId: string, diskId: string, now: Date): Promise<number | null>` (the new seq; null if the device or disk is outside the org)
  - `cancelNfcWrite(deviceId: string, seq: number): Promise<void>` (bumps seq, clears the disk, only if seq is still current)
  - `readWriteResult(deviceId: string, seq: number): Promise<{ result: string; uid: string | null } | null>`

- [ ] **Step 1: Failing route test.** Mock `requireDevice` (as in Task 3) and `storeWriteResult`.
  Assert:
  - a valid body `{ seq: 3, ok: true, uid: '24:19:b6:01' }` → 200 `{ stored: true }`, and the store
    was called with the device id from the token;
  - with the store returning false → 200 `{ stored: false }`;
  - `seq: -1`, a missing `ok`, a `uid` over 32 chars, or `reason` over 64 chars → 400, and the store
    was not called.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement the store functions**

```ts
export async function storeWriteResult(
  deviceId: string, r: { seq: number; ok: boolean; uid: string; reason?: string },
): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ nfcWriteSeq: devices.nfcWriteSeq, nfcWriteResultSeq: devices.nfcWriteResultSeq })
    .from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!row || !shouldStoreWriteResult(row, r.seq)) return false;
  // The seq in the WHERE too: a request issued between the read and this
  // write must not receive the older request's answer.
  const done = await db.update(devices).set({
    nfcWriteResultSeq: r.seq, nfcWriteResult: r.ok ? 'ok' : (r.reason ?? 'failed'), nfcWriteResultUid: r.uid,
  }).where(and(eq(devices.id, deviceId), eq(devices.nfcWriteSeq, r.seq))).returning({ id: devices.id });
  return done.length > 0;
}

export async function requestNfcWrite(orgId: string, deviceId: string, diskId: string, now: Date): Promise<number | null> {
  const db = getDb();
  const [disk] = await db.select({ id: disks.id }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  if (!disk) return null;
  const [r] = await db.update(devices).set({
    nfcWriteSeq: sql`${devices.nfcWriteSeq} + 1`, nfcWriteDiskId: diskId,
    nfcWriteExpiresAt: new Date(now.getTime() + NFC_WRITE_TTL_MS),
    nfcWriteResultSeq: null, nfcWriteResult: null, nfcWriteResultUid: null,
  }).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).returning({ seq: devices.nfcWriteSeq });
  return r?.seq ?? null;
}

export async function cancelNfcWrite(deviceId: string, seq: number): Promise<void> {
  await getDb().update(devices).set({ nfcWriteSeq: sql`${devices.nfcWriteSeq} + 1`, nfcWriteDiskId: null })
    .where(and(eq(devices.id, deviceId), eq(devices.nfcWriteSeq, seq)));
}

export async function readWriteResult(deviceId: string, seq: number) {
  const [r] = await getDb().select({
    resultSeq: devices.nfcWriteResultSeq, result: devices.nfcWriteResult, uid: devices.nfcWriteResultUid,
  }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return r && r.resultSeq === seq && r.result ? { result: r.result, uid: r.uid } : null;
}
```

Add `sql` to the drizzle import, and `NFC_WRITE_TTL_MS`, `shouldStoreWriteResult` to the rules
import.

- [ ] **Step 4: Implement the route** (same auth and parse shape as Task 3):

```ts
const body = z.object({
  seq: z.number().int().min(1),
  ok: z.boolean(),
  uid: z.string().min(1).max(32),
  reason: z.string().max(64).optional(),
});
// ...after parse:
const stored = await storeWriteResult(device.deviceId, parsed.data);
return Response.json({ stored }, { headers: NO_STORE });
```

- [ ] **Step 5: Tests pass; commit.**

```bash
git add src/lib/nfc/store.ts src/app/api/device/tap-write
git commit -m "device: POST /api/device/tap-write records a tag write's read-back for the current request only"
```

---

### Task 6: `pnpm nfc:write`

**Files:**
- Create: `src/lib/nfc/resolve.ts`, `src/lib/nfc/resolve.test.ts`, `scripts/nfc-write.ts`
- Modify: `package.json` (script)

**Interfaces:**
- Consumes: `requestNfcWrite`, `cancelNfcWrite`, `readWriteResult` (Task 5); `DISK_ID_RE` (Task 2).
- Produces:
  - `type DiskCandidate = { id: string; title: string; diskNo: number; tosecName: string | null; sourceFilename: string | null }`
  - `resolveDiskQuery(rows: DiskCandidate[], query: string): { kind: 'one'; disk: DiskCandidate } | { kind: 'many'; disks: DiskCandidate[] } | { kind: 'none' }`

- [ ] **Step 1: Failing resolver tests.** Cases:
  - a literal id → one;
  - `"Turrican II disk 1"` with two disks of Turrican II → the disk with `diskNo` 1;
  - `"turrican"` (case-insensitive substring of the title) with two disks → many;
  - an exact TOSEC name or filename (case-insensitive) → one;
  - no match → none;
  - a query matching a title *and* a different disk's filename → many (never a guess).

- [ ] **Step 2: Implement.** Rules, in order:
  1. `DISK_ID_RE` match → that id's row, or none.
  2. An exact case-insensitive match on `tosecName` or `sourceFilename` → one.
  3. Strip a trailing `/\s+disk\s+(\d+)$/i`, remembering the number.
  4. Candidates = rows whose title contains the rest (case-insensitive), filtered to that disk
     number if one was given.
  5. One candidate → one; more → many; none → none.

- [ ] **Step 3: The script.** `scripts/nfc-write.ts`, reading `DATABASE_URL` from `.env.local`
  via the dotenv wrapper, like `firmware-release.ts`:
  1. **Parse args:** a query, and an optional `--device <name-or-id>`.
  2. **Find the org's devices.** Only one org exists on this deployment, but still pick by
     device: select the devices; with `--device`, match its name or id; with none and exactly one
     device, use it; otherwise print the devices and exit 2.
  3. **Refuse a board without a reader.** If the device's `nfcReader !== 'present'`, print
     `"<name>" reports its NFC reader as <value ?? 'unknown (older firmware)'> -- nothing to write
     with.` and exit 2.
  4. **Resolve the disk.** Load that org's disks as `DiskCandidate` (disks joined to games, plus
     entitlements' `sourceFilename`) and call `resolveDiskQuery`: `many` → print them numbered
     (`title — disk N — id`) and exit 2; `none` → say so and exit 2.
  5. **Request and wait.** `requestNfcWrite`, then print
     `Tap a tag on <device> to write "<title> disk N" (2 min)… Ctrl-C cancels.` Poll
     `readWriteResult` every second.
  6. **Report.** On `ok`, print `Written to tag <uid>, read back OK.` and exit 0. On another result,
     print `Write failed: <reason> (tag <uid>)` and exit 1. On a 2-minute timeout or SIGINT, call
     `cancelNfcWrite`, say so, and exit 1.
  7. **Add the script** to `package.json`: `"nfc:write": "dotenv -e .env.local -- tsx scripts/nfc-write.ts"`.

- [ ] **Step 4: Tests pass; `pnpm tsc --noEmit -p .` clean; commit.**

```bash
git add src/lib/nfc/resolve.ts src/lib/nfc/resolve.test.ts scripts/nfc-write.ts package.json
git commit -m "nfc: pnpm nfc:write resolves a disk, arms the board and waits for the read-back"
```

---

### Task 7: Firmware tag codec

**Files:**
- Create: `wifi-floppy/firmware/src/nfc_tag.h`, `nfc_tag.c`, `test/test_nfc_tag.c`
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (add `src/nfc_tag.c` to the target sources, next
  to `src/display.c`)

**Interfaces:**
- Produces:
```c
#define NFC_TAG_BYTES   48      // blocks 4, 5, 6
#define NFC_DISK_ID_LEN 36
typedef enum { NFC_TAG_OK, NFC_TAG_NOT_OURS, NFC_TAG_BAD_DATA } nfc_tag_result_t;
uint16_t nfc_crc16(const uint8_t *b, int n);                       // CRC-16/CCITT-FALSE
bool nfc_disk_id_valid(const char *id);                            // the DISK_ID_RE shape
bool nfc_tag_encode(const char *disk_id, uint8_t out[NFC_TAG_BYTES]);
nfc_tag_result_t nfc_tag_decode(const uint8_t in[NFC_TAG_BYTES], char disk_id[NFC_DISK_ID_LEN + 1]);
```

- [ ] **Step 1: Write the failing host tests** (`test/test_nfc_tag.c`, in harness.h style):

```c
#include "harness.h"
#include "../src/nfc_tag.h"

static const char *ID = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";

static void crc_check_value(void) {
    // The standard check value for CRC-16/CCITT-FALSE over "123456789".
    CHECK_EQ_INT(nfc_crc16((const uint8_t *)"123456789", 9), 0x29B1);
}
static void round_trip(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    CHECK(nfc_tag_encode(ID, b), "encode");
    CHECK(memcmp(b, "WFDK", 4) == 0, "marker");
    CHECK_EQ_INT(b[4], 1); CHECK_EQ_INT(b[5], 36);
    CHECK_EQ_INT(b[44], 0); CHECK_EQ_INT(b[47], 0);          // padding
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_OK);
    CHECK(strcmp(out, ID) == 0, "id back");
}
static void refuses_bad_ids(void) {
    uint8_t b[NFC_TAG_BYTES];
    CHECK(!nfc_tag_encode("A1B2C3D4-E5F6-5A7B-8C9D-0E1F2A3B4C5D", b), "uppercase");
    CHECK(!nfc_tag_encode("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", b), "not v5 shape");
    CHECK(!nfc_tag_encode("short", b), "short");
}
static void blank_tag_is_not_ours(void) {
    uint8_t b[NFC_TAG_BYTES] = {0}; char out[NFC_DISK_ID_LEN + 1];
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_NOT_OURS);
}
static void flipped_bit_is_bad_data(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[20] ^= 0x01;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void wrong_version_or_length_is_bad_data(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[4] = 2;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
    nfc_tag_encode(ID, b); b[5] = 35;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void half_written_tag_is_bad_data(void) {
    // Block 4 of a new id over blocks 5-6 of an old one: what a tag pulled
    // away mid-write leaves. Must never decode as either id.
    uint8_t a[NFC_TAG_BYTES], b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, a); nfc_tag_encode("ffffffff-0000-5000-9000-000000000000", b);
    memcpy(b, a, 16);
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void decoded_id_is_revalidated(void) {
    // A correct CRC over a malformed id (a tag written by something else
    // using our marker) must still be refused.
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[6] = 'Z';
    uint16_t crc = nfc_crc16(b, 42); b[42] = (uint8_t)(crc >> 8); b[43] = (uint8_t)crc;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
int main(void) {
    RUN(crc_check_value); RUN(round_trip); RUN(refuses_bad_ids); RUN(blank_tag_is_not_ours);
    RUN(flipped_bit_is_bad_data); RUN(wrong_version_or_length_is_bad_data);
    RUN(half_written_tag_is_bad_data); RUN(decoded_id_is_revalidated);
    return REPORT();
}
```

- [ ] **Step 2: Run them and see them fail.** `cd wifi-floppy/firmware && ./test/run.sh 2>&1 | grep -A3 nfc_tag` Expected: COMPILE FAIL (no header).

- [ ] **Step 3: Implement `nfc_tag.c`**

The layout is 42 content bytes (marker 4 + version 1 + length 1 + id 36), the CRC at [42..43], and
zeros at [44..47]. CRC-16/CCITT-FALSE: `crc = 0xFFFF; for each byte: crc ^= b << 8; 8×: crc =
(crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1`, masked to 16 bits. `nfc_disk_id_valid` checks
length 36; hyphens at 8, 13, 18, 23; lowercase hex elsewhere; `id[14] == '5'`; `id[19]` in `89ab`.
Decode order:
1. A marker mismatch → NOT_OURS.
2. Version ≠ 1, or length ≠ 36 → BAD_DATA.
3. A CRC mismatch → BAD_DATA.
4. Copy out the id and NUL-terminate it. If `!nfc_disk_id_valid` → BAD_DATA.
5. Otherwise → OK.

The file must include only C standard headers (it's host-tested).

- [ ] **Step 4: Run them and see them pass.** `./test/run.sh` → `test_nfc_tag.c: N checks, 0 failed`, and the totals are unchanged elsewhere.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/nfc_tag.[ch] wifi-floppy/firmware/test/test_nfc_tag.c wifi-floppy/firmware/CMakeLists.txt
git commit -m "firmware: the NFC tag codec -- WFDK v1 in sector 1, CRC-16, the disk-id shape re-checked"
```

---

### Task 8: Server e2e

**Files:**
- Create: `e2e/nfc-tap.spec.ts`
- Modify: `e2e/device-helpers.ts` only if a helper is missing (reuse `seedDevices`, `seedDisk`,
  `authHeader`, `cleanupSeeded` as the other device specs do; read `e2e/device-status.spec.ts`
  first for the pattern)

**Prerequisite (controller):** migration 0025 is applied to the live DB.

- [ ] **Step 1: Write the spec.** Tests:
  1. **A tap mounts:** a paired device with a token taps a seeded disk's id → 200
     `{ outcome: 'mounting', title }`, and a poll with `since=0` returns `desired.diskId` equal to
     the id.
  2. **Same tag again:** after waiting 1.1 s, → `already`, and the desired version is unchanged.
  3. **A burst is ignored:** within 1 s → `ignored`.
  4. **Another org's disk:** a disk seeded for a *second* org → `not_found`, byte-identical in
     body to a random well-formed unknown id's answer.
  5. **A write round trip:** call `requestNfcWrite` (import it from `src/lib/nfc/store`, as other
     specs import libs, or use SQL through the helpers' DB handle) → a poll with `nfcAck=0` returns
     `nfcWrite { seq, diskId, title }` → a poll with `nfcAck=<seq>` holds and returns 204 → POST
     `/api/device/tap-write` `{ seq, ok: true, uid: '24:19:b6:01' }` → `{ stored: true }` → the
     same again → `{ stored: false }` → `readWriteResult` gives `ok`.
  6. **A cancel reaches the board:** `requestNfcWrite`, then `cancelNfcWrite` → a poll with the old
     ack returns `nfcWrite.diskId === null`.
  7. **The reader state is stored:** a status POST with `nfcReader: 'present'` → the column reads
     `present`.

- [ ] **Step 2: Run it** on port 3100, with your own dev server, alone on the DB:
  `PORT=3100 BASE_URL=http://localhost:3100 pnpm e2e e2e/nfc-tap.spec.ts`. Grep for "failed".

- [ ] **Step 3: Commit.** `git add e2e/nfc-tap.spec.ts e2e/device-helpers.ts && git commit -m "e2e: tap, same-tag, burst, foreign disk, write round trip and cancel"`

---

### Task 9: Firmware reader state machine (pure, against a fake Si512)

**Files:**
- Create: `wifi-floppy/firmware/src/nfc_reader.h`, `nfc_reader.c`
- Create: `wifi-floppy/firmware/test/si512_fake.h`, `si512_fake.c`, `test/test_nfc_reader.c`
- Modify: `test/run.sh`, only if the fake needs compiling in (it's under `test/`, so check how
  `transport_fake.c` is linked and do the same)

**Interfaces:**
- Consumes: `nfc_tag_decode`, `nfc_tag_encode`, `nfc_disk_id_valid` (Task 7).
- Produces:
```c
typedef struct {
    bool (*wr)(void *ctx, uint8_t reg, uint8_t v);   // false = transfer failed
    int  (*rd)(void *ctx, uint8_t reg);               // <0 = transfer failed
    void *ctx;
} nfc_bus_t;
typedef enum { NFC_EV_NONE, NFC_EV_TAG_READ, NFC_EV_NOT_OURS, NFC_EV_UNREADABLE,
               NFC_EV_WRITE_DONE, NFC_EV_PRESENT, NFC_EV_ABSENT } nfc_ev_kind_t;
typedef struct {
    nfc_ev_kind_t kind;
    uint8_t  uid[4]; int uid_len;
    char     disk_id[37];            // TAG_READ
    const char *why;                 // UNREADABLE / WRITE_DONE failure: "locked", "bad data", "moved"
    uint32_t seq; bool ok;           // WRITE_DONE
} nfc_event_t;
#define NFC_MAX_OPS_PER_STEP 4
typedef struct nfc_reader nfc_reader_t;          // defined in the header, fields private by convention
void nfc_init(nfc_reader_t *r, const nfc_bus_t *bus, uint32_t (*now_ms)(void));
int  nfc_step(nfc_reader_t *r);                  // returns register ops used (<= NFC_MAX_OPS_PER_STEP)
bool nfc_take_event(nfc_reader_t *r, nfc_event_t *out);   // one-slot; false = none
void nfc_arm_write(nfc_reader_t *r, uint32_t seq, const char *disk_id);
void nfc_disarm(nfc_reader_t *r);
bool nfc_present(const nfc_reader_t *r);
```

**The protocol, which must match the vendor code:** the vendor's
`SI512_App.c` (in `~/Downloads/HW-147C-V0.0.1-20240904-1/si512例程.zip`, under
`si512/SPI通信/STM32F030F4P6/Si512 读A卡 SPI/appliactions/Src/`; the filenames are GBK, so
extract them with Python `zipfile`, re-decoding the names cp437→gbk) is the reference for:
- `PCD_SI512_TypeA_Init`: the init, Initiator first;
- `PcdComMF522`: the transceive and the IRQ wait (`irqEn 0x77`, `waitFor 0x30`, ErrorReg mask
  `0x1B`, reading `ControlReg & 0x07` for the last bits);
- `PcdRequest` / `PcdAnticoll` / `PcdSelect`, and `CalulateCRC` (CRC_A via the chip's CalcCRC,
  command 0x03, polled on `DivIrqReg` 0x05 bit 0x04);
- `PcdAuthState`: command 0x0E, FIFO = `0x60, block, key[6], uid[4]`; success = `Status2Reg`
  (0x08) bit 0x08;
- `PcdRead`: `0x30, block` + CRC → 16 bytes + CRC;
- `PcdWrite`: `0xA0, block` + CRC → a 4-bit ACK `0x0A`, then 16 bytes + CRC → ACK.

Port them as **states**, never loops that wait. Keep register names as the vendor uses them.

**State sketch** (each arrow is one or more `nfc_step` calls):
- `ABSENT`: every 5 s, one VersionReg read. An answer → `INIT`, and emit `PRESENT`.
- `INIT`: the vendor Type A init, spread over steps, 4 ops each. → `IDLE`.
- `IDLE`: every 250 ms → `REQ`.
- `REQ`: WUPA 0x52, 7 bits → `WAIT_IRQ`.
- `WAIT_IRQ`: waiting on the transceive; a timer IRQ or a timeout means no tag.
- After a tag answers: `ANTICOLL` → `SELECT` (with CRC) → `AUTH` (sector 1, key A) →
  `READ` (4, 5, 6) or `WRITE` (4, 5, 6 with ACKs) → `READBACK` (4, 5, 6) → `REPORT` →
  `COOLDOWN` (field off 10 ms, then `IDLE`).
- **Debounce:** keep the last reported UID and `last_seen_ms`. The same UID seen again within
  1000 ms of its last sighting → no event (still update `last_seen_ms`). A different UID, or the
  same UID after more than 1000 ms of absence → a new event.
- **Loss of the chip:** three consecutive failed transfers in any state → `ABSENT`, emit `ABSENT`,
  and **discard any partly built event**.
- **Writes:** while a write is armed, a tag arrival runs `WRITE` instead of `READ`, whatever the
  tag holds. A write emits `WRITE_DONE{seq, ok, why}` and disarms. ok means a byte-identical
  read-back of all 48 bytes. Auth failure → `why = "locked"`; a transceive error or timeout in
  the middle → `"moved"`; a read-back mismatch → `"verify"`.
- **Budget:** `nfc_step` counts every `wr`/`rd` call and never exceeds `NFC_MAX_OPS_PER_STEP`. A
  FIFO load of 12 bytes takes 3 steps.

- [ ] **Step 1: Write the fake Si512** (`test/si512_fake.[ch]`). It's a register model with a
  scripted tag, not a byte-accurate emulator:
  - `CommandReg` writes with Transceive/MFAuthent/CalcCRC consume the FIFO and act on the
    scripted tag;
  - WUPA with a tag present → FIFO gets the ATQA `04 00` and `ComIrqReg |= 0x30`; with no tag →
    `ComIrqReg |= 0x01`;
  - `93 20` → the UID and BCC; SELECT → the SAK `08`;
  - MFAuthent with the right key → `Status2Reg |= 0x08`, and with a wrong key it stays clear;
  - READ block → 16 bytes; WRITE → ACK 0x0A (4 bits, `ControlReg & 7 = 4`);
  - CalcCRC → `CRCResultRegL/H` (0x22/0x21) = a real CRC_A (poly 0x8408 reflected, init 0x6363).

  Fields: `bool tag_present; uint8_t uid[4]; uint8_t sector1[48]; bool locked; int vanish_after_ops`
  (-1 = never; after N ops every transfer fails) and `int ops`. Provide
  `nfc_bus_t si512_fake_bus(si512_fake_t *)`.

- [ ] **Step 2: Write the failing tests** (`test/test_nfc_reader.c`). Each test builds the fake, a
  stepped clock (`static uint32_t now; static uint32_t clk(void){return now;}`), and a helper
  `run(r, ms)` that calls `nfc_step` then `now += 1`, repeated `ms` times, asserting after every
  step `ops <= NFC_MAX_OPS_PER_STEP` (**that assertion is the budget test**). Tests:
  1. `absent_chip_stays_absent_and_rechecks`: the fake never answers → no events in 10 s, and
     only ~2 VersionReg reads (one per 5 s).
  2. `present_chip_inits_and_emits_present`: exactly one `PRESENT`; ControlReg was written 0x10
     **before** any TxControlReg write (record the write order in the fake).
  3. `tag_read_reports_disk_id`: sector 1 = `nfc_tag_encode(ID)` → one `TAG_READ` with that id and
     the UID.
  4. `same_tag_held_reports_once`: the tag stays for 10 s → exactly one `TAG_READ`.
  5. `tag_removed_and_returned_reports_twice`: present 2 s, absent 2 s, present 2 s → two
     `TAG_READ`s.
  6. `blank_tag_is_not_ours`: sector 1 zeroed → one `NOT_OURS`.
  7. `locked_tag_is_unreadable_locked`: `locked = true` → one `UNREADABLE` with `why` "locked".
  8. `chip_vanishes_mid_read`: `vanish_after_ops` set to land inside the READ states → one
     `ABSENT` event, and **no** `TAG_READ`, `UNREADABLE` or `NOT_OURS`.
  9. `write_armed_writes_and_verifies`: arm seq 7 with ID, then the tag arrives →
     `WRITE_DONE{seq 7, ok}`, the fake's sector1 equals the encoding, and the next arrival (after
     1 s away) is a plain `TAG_READ` (disarmed).
  10. `write_to_locked_tag_fails_locked`.
  11. `write_readback_mismatch_fails_verify`: the fake flips a bit on its next READ.
  12. `disarm_before_tag_means_plain_read`.

- [ ] **Step 3: Run them and see them fail** (compile fail).

- [ ] **Step 4: Implement `nfc_reader.c`.** Only C standard headers plus `nfc_tag.h`. No
  `sleep`. Every chip wait is a state that re-reads one register per step, with a deadline taken
  from `now_ms` (25 ms for a transceive, 10 ms for CalcCRC, 50 ms for the soft reset).

- [ ] **Step 5: All green** (`./test/run.sh` totals: previous + the new checks, 0 failed).

- [ ] **Step 6: Commit.**

```bash
git add wifi-floppy/firmware/src/nfc_reader.[ch] wifi-floppy/firmware/test/si512_fake.[ch] wifi-floppy/firmware/test/test_nfc_reader.c wifi-floppy/firmware/test/run.sh
git commit -m "firmware: the Si512 reader as a budgeted state machine -- debounced taps, verified writes, a vanishing chip"
```

---

### Task 10: Device client: interruptible poll, `nfcWrite`, taps, write reports, `nfcReader`

**Files:**
- Modify: `wifi-floppy/firmware/src/transport.h`, `src/transport_tls.c`, `test/transport_fake.[ch]`
- Modify: `src/device_client.h`, `src/device_client.c`, `test/test_device_client.c`
- Modify: `src/lib/device-limits.ts` (server), only if Task 4 changed a bound the firmware
  mirrors

**Interfaces:**
- Produces:
```c
// transport.h
#define TRANSPORT_INTERRUPTED (-100)
// in transport_t: optional; checked while a read is WAITING for data. NULL = never.
bool (*interrupted)(void *ctx); void *interrupt_ctx;

// device_client.h
typedef enum { DC_TAP_MOUNTING, DC_TAP_ALREADY, DC_TAP_NOT_FOUND, DC_TAP_TOO_LONG,
               DC_TAP_IGNORED, DC_TAP_FAILED } dc_tap_outcome_t;   // FAILED = no answer (offline)
void dc_set_poll_interrupt(device_client_t *c, bool (*fn)(void *ctx), void *ctx);
dc_tap_outcome_t dc_tap(device_client_t *c, const char *disk_id, char *title_out, int title_cap);
bool dc_tap_write_report(device_client_t *c, uint32_t seq, bool ok, const char *uid_hex, const char *why);
void dc_set_nfc_reader(device_client_t *c, const char *state);   // "present"/"absent"/NULL = omit
// in device_client_t:
uint32_t nfc_ack;                        // echoed as &nfcAck= on every poll
bool     nfc_write_new;                  // set when a poll delivered nfcWrite with seq > nfc_ack
uint32_t nfc_write_seq;
char     nfc_write_disk_id[37];          // "" = disarm
char     nfc_write_title[DC_TITLE_MAX + 1];
bool     poll_interrupted;               // the last dc_step ended on TRANSPORT_INTERRUPTED
```
- **Contract:**
  - `dc_step` appends `&nfcAck=%u` to the poll path.
  - **`nfcWrite` handling:** if the body carries `nfcWrite` with `seq > nfc_ack`, set
    `nfc_write_new`, `nfc_write_seq`, `nfc_write_disk_id` (empty for a JSON null, or for an id
    failing `nfc_disk_id_valid`) and `nfc_write_title`. **The caller** sets
    `c->nfc_ack = c->nfc_write_seq` after acting on it. Lift `nfcWrite` with `json_object` before
    the disk logic's flat scans, **exactly as `dc_take_fw_fields` lifts `update`, and for the same
    reason** (its `diskId` would otherwise be found by them).
  - **The interrupt applies to the poll request only:** set `t->interrupted` just before the poll's
    `dc_exchange` and clear it after. On a read returning `TRANSPORT_INTERRUPTED`: `dc_abandon`,
    set `poll_interrupted = true`, **no backoff**, state unchanged, return.
  - **The tap and write report** use `dc_post` with a JSON body:
    - `dc_tap` POSTs `/api/device/tap` `{"diskId":"<id>"}`, parses `outcome` (and `title`,
      clipped to `title_cap`), and maps the outcome to the enum. Transport failure or non-2xx →
      `DC_TAP_FAILED`.
    - `dc_tap_write_report` POSTs `/api/device/tap-write`
      `{"seq":N,"ok":true|false,"uid":"..","reason":".."}`, with `reason` omitted when ok.
  - **`dc_report_status`** adds `,"nfcReader":"present"|"absent"` when set. Extend
    `test_status_body_fits_at_maximum` to include it.

- [ ] **Step 1: Failing tests** in `test/test_device_client.c` (using `transport_fake`'s scripted
  responses, like the neighbouring tests):
  1. `poll_carries_nfc_ack`: with `c.nfc_ack = 5`, the request line contains `nfcAck=5`.
  2. `poll_body_nfc_write_arms`: a body with `"nfcWrite":{"seq":6,"diskId":"<ID>","title":"T"}` →
     `nfc_write_new`, seq 6, the id, title "T"; the desired-disk handling is unaffected (the
     `diskId` inside `nfcWrite` must not be read as the desired disk).
  3. `nfc_write_cancel_disarms`: `"nfcWrite":{"seq":7,"diskId":null,"title":null}` → new, and the
     id is empty.
  4. `nfc_write_stale_seq_ignored`: seq ≤ `nfc_ack` → not new.
  5. `nfc_write_bad_id_disarms`: a malformed id → an empty id (never armed with garbage).
  6. `poll_interrupted_returns_without_backoff`: the fake returns `TRANSPORT_INTERRUPTED` on read →
     `poll_interrupted`, `backoff_ms` unchanged, the state isn't `DC_BACKOFF`, and the connection
     was abandoned.
  7. `tap_maps_outcomes`: each server outcome string → its enum; a garbage body → FAILED; a
     transport error → FAILED; the title is clipped.
  8. `tap_write_report_body`: the exact JSON bodies for ok and for a failure.
  9. `status_includes_nfc_reader`.

  `transport_fake` gains a way to script "the next read returns `TRANSPORT_INTERRUPTED`", and
  records that `abandon` was called. Follow its existing scripting style.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - **`tls_read`:** in the wait loop, before the deadline check, add
    `if (t->interrupted && t->interrupted(t->interrupt_ctx)) return TRANSPORT_INTERRUPTED;`.
  - **`dc_attempt`:** distinguish `got == TRANSPORT_INTERRUPTED` from other negatives, and
    propagate it up through `dc_exchange` without the reused-connection retry (an interrupt is
    not a dead socket).
  - Keep the RULE at the top of `device_client.h`: no SDK headers in `device_client.c`.

- [ ] **Step 4: All green; commit.**

```bash
git add wifi-floppy/firmware/src/transport.h wifi-floppy/firmware/src/transport_tls.c wifi-floppy/firmware/src/device_client.[ch] wifi-floppy/firmware/test/transport_fake.[ch] wifi-floppy/firmware/test/test_device_client.c
git commit -m "firmware: a tap can interrupt the held poll; the client speaks nfcAck, nfcWrite, /tap, /tap-write and nfcReader"
```

---

### Task 11: Firmware integration (main.c, the real bus, version 1.3.0)

**Files:**
- Create: `wifi-floppy/firmware/src/nfc_bus_i2c.[ch]` (device-only: `i2c1` at 0x28, 5 ms
  timeouts; `rd` = write the register address with nostop, then read 1 byte)
- Modify: `src/main.c`, `CMakeLists.txt` (sources `nfc_reader.c`, `nfc_bus_i2c.c`;
  `FIRMWARE_SEMVER` 1.3.0), `test/run.sh` (exclude `nfc_bus_i2c.c` as device-only, with a comment
  like `i2c_probe.c`'s)

**Interfaces:**
- Consumes: everything in Tasks 7, 9 and 10.

- [ ] **Step 1: Core0.** Next to `display_pump(...)` (main.c ~line 2213):
  - Call `nfc_step(&g_nfc)` **only when the display pump sent nothing this pass** (make
    `display_pump`'s return value the bytes sent; check `display.h`), so the two share the slot.
  - Then `nfc_take_event` → publish it into a core0→core1 mailbox. Use the same seq-counter,
    `__dmb()` pattern as `ui_publish`/`ui_snapshot`, with a single slot. **An unconsumed event is
    overwritten by a newer one**; a tap that core1 never saw loses to the next.
  - Read core1's write-request mailbox (`{seq, disk_id}`, the same pattern), and call
    `nfc_arm_write`/`nfc_disarm` when its seq changes.
  - At boot, after `i2c_probe_bus`, call `nfc_init` with the I2C bus. If a panel exists, the bus is
    already initialised at 400 kHz. **If no panel answered, `i2c_probe_bus` still initialised
    i2c1 (at 100 kHz)**: leave that rate as is.
  - Blink the activity LED once on `TAG_READ`, `NOT_OURS` and `UNREADABLE`.

- [ ] **Step 2: Core1**, in the loop around `dc_step` (~line 1314):
  - `dc_set_poll_interrupt(&c, nfc_event_pending, NULL)`, where `nfc_event_pending` reads the
    mailbox seq against the last consumed seq. It's cheap, and safe to call from inside `tls_read`
    on core1.
  - Before choosing between uploader and poll, and after `dc_step` returns, consume one event:
    - `TAG_READ`: `dc_tap`, then show `Tag: <title>` / `Tag: already in drive` /
      `Tag: not in library` / `Tag: too long for board` / `Tag: offline` via
      `ui_publish(<current status>, NULL, "<line>", -1)`. Revert the detail after 3 s: keep
      `tag_line_until_ms`, and when it passes, re-publish the detail the observer last set.
    - `NOT_OURS` / `UNREADABLE`: show `Tag: not a disk tag` / `Tag: unreadable` /
      `Tag: locked`.
    - `WRITE_DONE`: `dc_tap_write_report(&c, seq, ok, uid_hex, why)`; show `Tag written` /
      `Write failed`.
    - `PRESENT` / `ABSENT`: `dc_set_nfc_reader(&c, ...)`, and mark a status report owed (the same
      mechanism `fw_report_owed` uses).
  - **Write requests:** after `dc_step`, if `c.nfc_write_new`: publish `{seq, disk_id}` to core0's
    mailbox, set `c.nfc_ack = c.nfc_write_seq`, clear `nfc_write_new`, and show
    `Tap tag to write: <title>` (or restore the normal line on a disarm). Keep a 2-minute local
    expiry: past it, publish a disarm.
  - **Uploader:** while the uploader has work (`up_has_work`), taps are still posted; `dc_tap` uses
    the same connection **between** requests, never inside one.

- [ ] **Step 3: Build and host-test.**
  - `cmake --build build` with the release options, passing every `-DWF_*` explicitly (`BUS_SNIFF`,
    `FW_DEBUG`, `VERIFY_TRACKS` all OFF).
  - Check the generated version reads `1.3.0+g<hash>`, not a stale cached semver (use
    `cmake -U FIRMWARE_SEMVER -B build` if needed).
  - `./test/run.sh`: all green.

- [ ] **Step 4: Commit.**

```bash
git add wifi-floppy/firmware/src/main.c wifi-floppy/firmware/src/nfc_bus_i2c.[ch] wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/test/run.sh
git commit -m "firmware 1.3.0: NFC tap-to-mount -- reader on core0 in the display slot, taps and writes on core1"
```

---

### Task 12: Records, full gates, and the bench (controller + operator)

- [ ] **Step 1:** The whole-branch review (strongest model), then the fixes and a review of those
  fixes.
- [ ] **Step 2:** Apply migration 0025 to production (if not already done), run the full e2e
  alone on the DB, run vitest and the build.
- [ ] **Step 3:** Merge to master and push (server live), then build the firmware from master.
  Check whether Update accepts a target from the board's unregistered running version
  `1.2.0+g6b9db28`: read `refuseTarget` in `src/lib/firmware-update-rules.ts`. If yes,
  `pnpm firmware:publish` (dry run first) and the operator presses Update. If no, a BOOTSEL
  install.
- [ ] **Step 4:** Bench acceptance, spec §7. The operator does the physical steps, each ending a
  turn:
  - `pnpm nfc:write` a disk to the blue fob;
  - tap it → it mounts;
  - tap it again → no-op;
  - write the white card with another disk, tap it → it swaps;
  - a blank tag → "not a disk tag";
  - pull SDA → the drive carries on and status reads `absent`; reseat it → back;
  - tap during an Amiga disk read → 0 TRACK-MISS in the log.
- [ ] **Step 5:** Update HANDOFF (status table row, NFC entry, a new §3 section) and memory. Push.
