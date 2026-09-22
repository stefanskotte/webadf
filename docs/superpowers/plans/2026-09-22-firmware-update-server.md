# Firmware Update (Server Half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select devices in the Devices tab, press Update, confirm with a password, and watch each board converge on a published firmware release — with everything except the firmware itself.

**Architecture:** An update is desired state, not a job. It rides the poll body the device already parses, is fetched through a route mirroring `/api/device/image/[sha256]`, and is confirmed by the heartbeat increment 1 added. Completion is derived from the reported version, never claimed by the device.

**Tech Stack:** Next.js App Router, Drizzle + Neon Postgres, better-auth (email+password), Vercel Blob (private), Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-firmware-update-server-design.md`

## Global Constraints

- **No firmware implements this protocol.** Every test drives a *simulated* device via `pairDevice`'s real bearer token. Do not claim any of it proves a board can flash itself.
- **The Update control is gated on `updateProtocol >= 1`**, reported by the device. Every board today reports nothing, so the control must be invisible in production until firmware ships.
- **Never refuse an update because a disk is mounted.** It queues; the device applies it when nothing is mounted. (Spec D2.)
- **Anti-rollback on both sides:** the server refuses a target whose `sequence` is below the device's reported one, and the sequence travels in the poll body.
- **`desiredVersion` must NOT be bumped to announce a firmware update.** The device echoes it as `mountedVersion` and the server reads that for upload verdicts (HANDOFF §4g). Use the hold-release rule in spec §4.2.
- **Batch writes are all-or-nothing.** If any device fails a check, nothing is written.
- **The status schema rule:** an absent key means "not reported" and leaves the column alone; an explicit null clears it.
- **e2e port is 4100:** `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e`. Run it in the foreground.
- **Re-run `git status` immediately before staging**, every time. Never `git add -A` while anything under `wifi-floppy/` is dirty.
- **`firmware_releases` is global** — anything a test seeds there needs the `E2E_RELEASE_PREFIX` treatment already in `e2e/device-helpers.ts`.

---

### Task 1: The device columns

**Files:**
- Modify: `src/db/schema/devices.ts`
- Modify: `src/db/devices-schema.test.ts`
- Generated: a new file under `drizzle/`

**Interfaces:**
- Consumes: nothing.
- Produces: six columns on `devices` — `updateProtocol` (integer), `desiredFirmwareVersion` (text), `desiredFirmwareSetAt` (timestamptz), `desiredFirmwareSetByUserId` (text), `firmwareUpdateState` (text), `firmwareUpdateError` (text). All nullable. Tasks 2–8 read them.

- [ ] **Step 1: Write the failing test**

Append to `src/db/devices-schema.test.ts`:

```ts
describe('firmware update columns', () => {
  const col = (name: string) => getTableConfig(devices).columns.find((c) => c.name === name);

  it('carries the capability the device declares', () => {
    expect(col('update_protocol')).toBeDefined();
    // Nullable: every board in the field today reports nothing, and "absent"
    // must mean "cannot update" rather than defaulting to some level.
    expect(col('update_protocol')!.notNull).toBe(false);
  });

  it('carries the desired firmware and who asked for it', () => {
    for (const n of ['desired_firmware_version', 'desired_firmware_set_at',
                     'desired_firmware_set_by_user_id']) {
      expect(col(n), `missing ${n}`).toBeDefined();
      expect(col(n)!.notNull, `${n} must be nullable`).toBe(false);
    }
  });

  it('carries what the device reports about an update in flight', () => {
    expect(col('firmware_update_state')).toBeDefined();
    expect(col('firmware_update_error')).toBeDefined();
  });
});
```

`getTableConfig` must be imported from `drizzle-orm/pg-core` at the top of the file if it is not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/devices-schema.test.ts`
Expected: FAIL — `expect(col('update_protocol')).toBeDefined()` receives undefined.

- [ ] **Step 3: Add the columns**

In `src/db/schema/devices.ts`, inside `pgTable('devices', {...})`, after `mountedVersion`:

```ts
  // --- firmware updates (spec 2026-09-22-firmware-update-server-design) ---

  /**
   * What this board's firmware can do, as IT reports. Absent or 0 means it
   * cannot be updated -- which is every board in the field today, and is what
   * keeps the Update control invisible rather than dead. The capability gate
   * protects the poll as well as the UI: a device that cannot report update
   * state can never be targeted, so it can never busy-loop the hold (spec 4.2).
   */
  updateProtocol: integer('update_protocol'),

  /**
   * The release this board should end up running. Null means no update is
   * wanted. It is CLEARED by recordStatus the moment the device reports this
   * exact version -- completion is derived from what the board is running,
   * never from the board claiming success.
   */
  desiredFirmwareVersion: text('desired_firmware_version'),
  desiredFirmwareSetAt: timestamp('desired_firmware_set_at', { withTimezone: true }),
  /** Who asked. The super-admin plane has no audit log; this does not repeat that. */
  desiredFirmwareSetByUserId: text('desired_firmware_set_by_user_id'),

  /**
   * 'queued' | 'downloading' | 'applying' | 'failed', as the device reports.
   * Null means nothing in flight -- and, while desiredFirmwareVersion is set,
   * null specifically means "not acknowledged yet", which is what releases the
   * poll's hold exactly once (spec 4.2).
   */
  firmwareUpdateState: text('firmware_update_state'),
  firmwareUpdateError: text('firmware_update_error'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/devices-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate and apply the migration**

```bash
pnpm db:generate
```

Read the generated SQL. It must contain only `ALTER TABLE "devices" ADD COLUMN` statements.

**Do NOT run `pnpm db:push`.** On 2026-09-22 push offered to TRUNCATE `disk_versions` — which holds real Amiga write history — to add a constraint that already existed. Apply the generated statements directly instead, the way migration 0017 was applied:

```bash
cat > .tmp-apply.mts <<'EOF'
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const sql = neon(process.env.DATABASE_URL!);
const ddl = readFileSync(process.argv[2], 'utf8')
  .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
for (const s of ddl) {
  if (!/^ALTER TABLE "devices" ADD COLUMN/.test(s)) {
    throw new Error(`refusing, not an additive devices change:\n${s}`);
  }
}
for (const s of ddl) await sql.query(s);
console.log(`applied ${ddl.length} statement(s)`);
EOF
pnpm dotenv -e .env.local -- tsx .tmp-apply.mts drizzle/<the new file>.sql
rm -f .tmp-apply.mts
```

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/db/schema/devices.ts src/db/devices-schema.test.ts drizzle/
git commit -m "db: what firmware a device should run, and what it reports about getting there"
```

---

### Task 2: The device reports its capability and its progress

**Files:**
- Create: `src/lib/firmware-update-state.ts`
- Create: `src/lib/firmware-update-state.test.ts`
- Modify: `src/app/api/device/status/route.ts`
- Modify: `src/app/api/device/register/route.ts`
- Modify: `src/lib/mount.ts` (`recordStatus`)
- Test: `e2e/device-status.spec.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  ```ts
  export const UPDATE_STATES = ['queued', 'downloading', 'applying', 'failed'] as const;
  export type UpdateState = typeof UPDATE_STATES[number];
  export const updateStateSchema: z.ZodEnum<...>;      // the four above
  export const updateProtocolSchema: z.ZodNumber;      // int, 0..15
  ```
  Tasks 3 and 7 import these.

- [ ] **Step 1: Write the failing test**

Create `src/lib/firmware-update-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { updateStateSchema, updateProtocolSchema, UPDATE_STATES } from './firmware-update-state';

describe('updateStateSchema', () => {
  it('accepts exactly the four states a device may report', () => {
    expect(UPDATE_STATES).toEqual(['queued', 'downloading', 'applying', 'failed']);
    for (const s of UPDATE_STATES) expect(updateStateSchema.safeParse(s).success, s).toBe(true);
  });

  /**
   * There is deliberately no 'succeeded'. Completion is derived from the
   * version the board actually reports running -- a device that reports
   * success is a device that can be wrong about it.
   */
  it('has no success state', () => {
    expect(updateStateSchema.safeParse('succeeded').success).toBe(false);
    expect(updateStateSchema.safeParse('done').success).toBe(false);
  });
});

describe('updateProtocolSchema', () => {
  it('accepts a small integer capability level', () => {
    expect(updateProtocolSchema.safeParse(1).success).toBe(true);
    expect(updateProtocolSchema.safeParse(0).success).toBe(true);
  });

  // Telemetry must never be able to reject the whole report, but it also must
  // not accept a value that could only come from a confused board.
  it('refuses a negative or absurd level', () => {
    expect(updateProtocolSchema.safeParse(-1).success).toBe(false);
    expect(updateProtocolSchema.safeParse(9999).success).toBe(false);
    expect(updateProtocolSchema.safeParse(1.5).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/firmware-update-state.test.ts`
Expected: FAIL — `Cannot find module './firmware-update-state'`.

- [ ] **Step 3: Write the module**

Create `src/lib/firmware-update-state.ts`:

```ts
import { z } from 'zod';

/**
 * What a device may report about an update in flight.
 *
 * There is deliberately no 'succeeded'. Completion is derived in recordStatus
 * from the version the board actually reports running: a device that reports
 * success is a device that can be wrong about it, and the version it is
 * running is evidence it produces by running rather than by claiming.
 */
export const UPDATE_STATES = ['queued', 'downloading', 'applying', 'failed'] as const;
export type UpdateState = typeof UPDATE_STATES[number];

export const updateStateSchema = z.enum(UPDATE_STATES);

/**
 * The device's own statement of what it can do. Bounded rather than any
 * integer: a level of 9999 could only come from a confused board, and
 * accepting it would let the UI offer an update to something that cannot
 * take one.
 */
export const updateProtocolSchema = z.number().int().min(0).max(15);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/firmware-update-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Accept the fields on both device routes**

In `src/app/api/device/status/route.ts`, import `{ updateStateSchema, updateProtocolSchema }` from `@/lib/firmware-update-state` and add to `statusBody`, beside `firmwareVersion`:

```ts
  /** What this board can do. Absent leaves the column alone, as everywhere here. */
  updateProtocol: updateProtocolSchema.optional(),
  /** Null explicitly clears it -- "I am no longer mid-update". */
  firmwareUpdateState: updateStateSchema.nullable().optional(),
  firmwareUpdateError: z.string().max(200).nullable().optional(),
```

Pass all three through to `recordStatus`.

In `src/app/api/device/register/route.ts`, add `updateProtocol: updateProtocolSchema.optional()` to the body schema and write it on the inserted row.

- [ ] **Step 6: Persist them, and derive completion**

In `src/lib/mount.ts`, extend `recordStatus`'s parameter type with:

```ts
    updateProtocol?: number;
    firmwareUpdateState?: string | null;
    firmwareUpdateError?: string | null;
```

and, after the existing `firmwareVersion` patch line:

```ts
  if (s.updateProtocol !== undefined) patch.updateProtocol = s.updateProtocol;
  if (s.firmwareUpdateState !== undefined) patch.firmwareUpdateState = s.firmwareUpdateState;
  if (s.firmwareUpdateError !== undefined) patch.firmwareUpdateError = s.firmwareUpdateError;
```

Then, still inside `recordStatus`, add the completion rule. It must run in the SAME write as the version, so there is never a moment where the device is reported running the target while the update still looks pending:

```ts
  // An update is COMPLETE when the board reports running the exact version it
  // was asked to run. The device never says "I succeeded" -- this is the only
  // evidence that counts, and the board produces it by running rather than by
  // claiming. Read the current desired value first: it is not in `patch`, and
  // a partial report must not clear an update it said nothing about.
  if (s.firmwareVersion) {
    const [row] = await db
      .select({ want: devices.desiredFirmwareVersion })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (row?.want && row.want === s.firmwareVersion) {
      patch.desiredFirmwareVersion = null;
      patch.desiredFirmwareSetAt = null;
      patch.desiredFirmwareSetByUserId = null;
      patch.firmwareUpdateState = null;
      patch.firmwareUpdateError = null;
    }
  }
```

- [ ] **Step 7: Write the e2e round trip**

Append to `e2e/device-status.spec.ts`:

```ts
test('a device reports its update capability and its progress', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: {
      mountedSha256: null, updateProtocol: 1,
      firmwareUpdateState: 'downloading', firmwareUpdateError: null,
    },
  });
  expect(res.status()).toBe(204);

  const row = await deviceRow(deviceId);
  expect(row.updateProtocol).toBe(1);
  expect(row.firmwareUpdateState).toBe('downloading');
});

/**
 * The whole verification story. Nothing tells the server the update worked --
 * the board simply reports the version it is running, and that ending up equal
 * to what was asked for IS the success signal.
 */
test('reporting the desired version clears the update, with no success message', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const { getDb } = await import('@/db');
  const { devices } = await import('@/db/schema/devices');
  const { eq } = await import('drizzle-orm');
  await getDb().update(devices)
    .set({ desiredFirmwareVersion: '9.9.9+gfeedface', firmwareUpdateState: 'applying' })
    .where(eq(devices.id, deviceId));

  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '9.9.9+gfeedface' },
  });

  const row = await deviceRow(deviceId);
  expect(row.firmwareVersion).toBe('9.9.9+gfeedface');
  expect(row.desiredFirmwareVersion).toBeNull();
  expect(row.firmwareUpdateState).toBeNull();
});

test('reporting a DIFFERENT version leaves the update pending', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const { getDb } = await import('@/db');
  const { devices } = await import('@/db/schema/devices');
  const { eq } = await import('drizzle-orm');
  await getDb().update(devices)
    .set({ desiredFirmwareVersion: '9.9.9+gfeedface' })
    .where(eq(devices.id, deviceId));

  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.0.0+gsomething' },
  });

  const row = await deviceRow(deviceId);
  expect(row.desiredFirmwareVersion).toBe('9.9.9+gfeedface');
});
```

- [ ] **Step 8: Run the tests**

```bash
pnpm vitest run
PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/device-status.spec.ts
```
Expected: both green.

- [ ] **Step 9: Commit**

```bash
git status --short
git add src/lib/firmware-update-state.ts src/lib/firmware-update-state.test.ts \
        src/app/api/device/status/route.ts src/app/api/device/register/route.ts \
        src/lib/mount.ts e2e/device-status.spec.ts
git commit -m "device: a board declares what it can do, and reports how an update is going"
```

---

### Task 3: The rules for who may be targeted

**Files:**
- Create: `src/lib/firmware-update-rules.ts`
- Create: `src/lib/firmware-update-rules.test.ts`

**Interfaces:**
- Consumes: `ReleaseRef`, `Registry`, `firmwareState` from `@/lib/firmware-state`.
- Produces:
  ```ts
  export type TargetRefusal = 'cannot_update' | 'would_roll_back' | 'already_current';
  export interface TargetCandidate {
    id: string; name: string;
    updateProtocol: number | null;
    firmwareVersion: string | null;
  }
  export function refuseTarget(
    d: TargetCandidate, target: ReleaseRef, reg: Registry,
  ): TargetRefusal | null;
  ```
  Tasks 6 and 7 both call `refuseTarget` — the route to reject, the UI to decide whether to offer a checkbox. One rule, two readers.

- [ ] **Step 1: Write the failing test**

Create `src/lib/firmware-update-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRegistry, type ReleaseRef } from './firmware-state';
import { refuseTarget, type TargetCandidate } from './firmware-update-rules';

const rel = (version: string, sequence: number, semver: string): ReleaseRef =>
  ({ version, sequence, semver, security: false, notes: null });

const releases = [
  rel('1.0.0+ga111111', 1, '1.0.0'),
  rel('1.1.0+gb222222', 2, '1.1.0'),
  rel('1.2.0+gc333333', 3, '1.2.0'),
];
const reg = buildRegistry(releases);
const latest = releases[2];

const dev = (over: Partial<TargetCandidate> = {}): TargetCandidate => ({
  id: 'd1', name: 'Bench', updateProtocol: 1, firmwareVersion: '1.0.0+ga111111', ...over,
});

describe('refuseTarget', () => {
  it('allows a board that is behind', () => {
    expect(refuseTarget(dev(), latest, reg)).toBeNull();
  });

  // Every board in the field today. The UI never offers the control, so
  // reaching this means the page was stale.
  it('refuses a board that cannot update', () => {
    expect(refuseTarget(dev({ updateProtocol: null }), latest, reg)).toBe('cannot_update');
    expect(refuseTarget(dev({ updateProtocol: 0 }), latest, reg)).toBe('cannot_update');
  });

  it('refuses a board already running the target', () => {
    expect(refuseTarget(dev({ firmwareVersion: '1.2.0+gc333333' }), latest, reg))
      .toBe('already_current');
  });

  it('refuses a target below what the board runs', () => {
    const older = releases[0];
    expect(refuseTarget(dev({ firmwareVersion: '1.2.0+gc333333' }), older, reg))
      .toBe('would_roll_back');
  });

  /**
   * A board running something hand-flashed has no sequence, so nothing rules
   * it out -- and offering it the update is the RECOVERY path. This is the one
   * case where "we do not recognise this" must not become "we refuse".
   */
  it('allows an unrecognised build, which is how a hand-flashed board recovers', () => {
    expect(refuseTarget(dev({ firmwareVersion: 'verify-a286680' }), latest, reg)).toBeNull();
    expect(refuseTarget(dev({ firmwareVersion: '1.0.0+gdeadbee-dirty' }), latest, reg)).toBeNull();
  });

  it('allows a board that has never reported a version', () => {
    expect(refuseTarget(dev({ firmwareVersion: null }), latest, reg)).toBeNull();
  });

  // Re-flashing the same sequence is not a rollback; only going DOWN is.
  it('treats an equal sequence as already current, not a rollback', () => {
    expect(refuseTarget(dev({ firmwareVersion: '1.1.0+gb222222' }), releases[1], reg))
      .toBe('already_current');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/firmware-update-rules.test.ts`
Expected: FAIL — `Cannot find module './firmware-update-rules'`.

- [ ] **Step 3: Write the rules**

Create `src/lib/firmware-update-rules.ts`:

```ts
import type { ReleaseRef, Registry } from '@/lib/firmware-state';

/**
 * Whether a device may be told to run a particular release.
 *
 * Pure, and called from BOTH sides: the batch route rejects with it, and the
 * Devices page decides whether to offer a checkbox with it. One rule with two
 * readers cannot drift into a UI that offers what the server refuses.
 */
export type TargetRefusal = 'cannot_update' | 'would_roll_back' | 'already_current';

export interface TargetCandidate {
  id: string;
  name: string;
  updateProtocol: number | null;
  firmwareVersion: string | null;
}

export function refuseTarget(
  d: TargetCandidate,
  target: ReleaseRef,
  reg: Registry,
): TargetRefusal | null {
  // The capability gate. It protects the poll as well as the UI: a board that
  // cannot report update state could otherwise release the hold forever
  // (spec 4.2), because the hold releases while the state is unacknowledged.
  if (!d.updateProtocol || d.updateProtocol < 1) return 'cannot_update';

  const running = d.firmwareVersion ? reg.byVersion.get(d.firmwareVersion) : undefined;

  // No sequence: either nothing reported, or a build the registry has never
  // seen. Nothing rules it out, and this is the recovery path for a board
  // running something hand-flashed. "Unrecognised" must not become "refused".
  if (!running) return null;

  if (running.sequence === target.sequence) return 'already_current';
  if (running.sequence > target.sequence) return 'would_roll_back';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/firmware-update-rules.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/firmware-update-rules.ts src/lib/firmware-update-rules.test.ts
git commit -m "firmware: one rule for who may be updated, read by both the route and the UI"
```

---

### Task 4: The poll carries the update, and wakes for it once

**Files:**
- Modify: `src/lib/mount.ts` (`readDesired`, and a new `readFirmwareInstruction`)
- Modify: `src/app/api/device/poll/route.ts`
- Test: `e2e/device-poll.spec.ts`

**Interfaces:**
- Consumes: Task 1's columns, `firmwareReleases` from `@/db/schema/firmware`.
- Produces:
  ```ts
  export interface FirmwareInstruction {
    version: string; sequence: number; sha256: string;
    sizeBytes: number; signature: string; keyId: string;
  }
  /** The instruction, plus whether the poll should release its hold for it. */
  export async function readFirmwareInstruction(deviceId: string): Promise<{
    update: FirmwareInstruction | null;
    unacknowledged: boolean;
  }>;
  ```
  Task 5 serves the artifact this names; Task 8's e2e drives it.

- [ ] **Step 1: Write the failing test**

Append to `e2e/device-poll.spec.ts` (read the file first for its existing helpers and import style):

```ts
/**
 * The poll long-holds and returns a body only when desiredVersion moves, and a
 * 204 carries no update object -- so an update has to release the hold by
 * itself. It must do that exactly ONCE: releasing while the update merely
 * stays pending would turn the 25 s hold into a busy loop.
 */
test('a pending update releases the hold and rides the poll body', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.20+gaa20000');
  await setDesiredFirmware(deviceId, '0.0.0-e2e.20+gaa20000');

  const res = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.update).toMatchObject({
    version: '0.0.0-e2e.20+gaa20000',
    sha256: 'e'.repeat(64),
    keyId: 'e2e',
  });
  expect(typeof body.update.sequence).toBe('number');
});

test('once the device acknowledges, the poll holds normally again', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.21+gaa21000');
  await setDesiredFirmware(deviceId, '0.0.0-e2e.21+gaa21000');

  // Acknowledge, the way a board would.
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareUpdateState: 'downloading' },
  });

  const started = Date.now();
  const res = await request.get('/api/device/poll?since=1', { headers: authHeader(token) });
  // It must now HOLD rather than answering at once. 204 after the hold, or a
  // 200 only because desiredVersion genuinely moved -- never an instant 200
  // caused by the update still being pending.
  expect(Date.now() - started).toBeGreaterThan(2000);
  expect([200, 204]).toContain(res.status());
});

test('a device with no update gets no update field', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get('/api/device/poll?since=999999', { headers: authHeader(token) });
  if (res.status() === 200) expect((await res.json()).update).toBeUndefined();
});
```

Add `setDesiredFirmware` to `e2e/device-helpers.ts`:

```ts
/** Sets desired firmware directly, the way Task 6's route will. */
export async function setDesiredFirmware(deviceId: string, version: string): Promise<void> {
  await getDb().update(devices)
    .set({ desiredFirmwareVersion: version, desiredFirmwareSetAt: new Date(),
           desiredFirmwareSetByUserId: 'e2e', firmwareUpdateState: null })
    .where(eq(devices.id, deviceId));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/device-poll.spec.ts`
Expected: FAIL — `body.update` is undefined.

- [ ] **Step 3: Read the instruction**

In `src/lib/mount.ts`, add:

```ts
export interface FirmwareInstruction {
  version: string;
  /** For the board's OWN anti-rollback check. A rule only the server enforces
   *  is a rule a compromised server can skip. */
  sequence: number;
  sha256: string;
  sizeBytes: number;
  signature: string;
  keyId: string;
}

/**
 * What firmware this device should be running, if any, and whether it has yet
 * said anything about it.
 *
 * `unacknowledged` is what lets the poll release its hold exactly once: while
 * an update is wanted and firmwareUpdateState is still null, the device has
 * not seen it. The moment it reports any state -- including 'failed' -- the
 * hold goes back to normal, which is also why a failed update never
 * auto-retries.
 */
export async function readFirmwareInstruction(deviceId: string): Promise<{
  update: FirmwareInstruction | null;
  unacknowledged: boolean;
}> {
  const [row] = await getDb()
    .select({
      want: devices.desiredFirmwareVersion,
      state: devices.firmwareUpdateState,
      version: firmwareReleases.version,
      sequence: firmwareReleases.sequence,
      sha256: firmwareReleases.sha256,
      sizeBytes: firmwareReleases.sizeBytes,
      signature: firmwareReleases.signature,
      keyId: firmwareReleases.signingKeyId,
    })
    .from(devices)
    .leftJoin(firmwareReleases, eq(firmwareReleases.version, devices.desiredFirmwareVersion))
    .where(eq(devices.id, deviceId))
    .limit(1);

  // A desired version whose release has been deleted resolves to no
  // instruction rather than a half-built one. The device simply does not
  // update, which is the safe direction.
  if (!row?.want || !row.version) return { update: null, unacknowledged: false };

  return {
    update: {
      version: row.version, sequence: row.sequence, sha256: row.sha256,
      sizeBytes: row.sizeBytes, signature: row.signature, keyId: row.keyId,
    },
    unacknowledged: row.state === null,
  };
}
```

Import `firmwareReleases` from `@/db/schema/firmware` at the top of `mount.ts`.

- [ ] **Step 4: Release the hold, and emit the field**

In `src/app/api/device/poll/route.ts`, import `readFirmwareInstruction`. Inside the hold loop, replace the existing release condition block with:

```ts
    const fw = await readFirmwareInstruction(device.deviceId);

    const clampedFrom = Math.min(from, version);
    // An update the device has not acknowledged releases the hold on its own.
    // desiredVersion is deliberately NOT bumped to announce one: the device
    // echoes it back as mountedVersion and the server reads that for an
    // upload's not_mounted/behind verdict (HANDOFF 4g), so bumping it could
    // strand an Amiga write that was mid-session. See spec 4.2.
    if (version > clampedFrom || clampedFrom !== from || fw.unacknowledged) {
      const state = await readDesired(device.deviceId);
      if (!state) return notFound();
      return Response.json(
        // `update` last, after the disk fields, so a truncated body loses it
        // rather than losing what the disk depends on -- the same ordering
        // argument DC_POLL_BODY_BYTES already makes. A board that loses it
        // simply does not update.
        { version: state.version, desired: state.desired, ...(fw.update ? { update: fw.update } : {}) },
        { headers: NO_STORE },
      );
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/device-poll.spec.ts`
Expected: all PASS, including the existing poll tests.

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/lib/mount.ts src/app/api/device/poll/route.ts \
        e2e/device-poll.spec.ts e2e/device-helpers.ts
git commit -m "device: an update rides the poll body, and wakes the hold exactly once"
```

---

### Task 5: Serving the artifact

**Files:**
- Create: `src/app/api/device/firmware/[version]/route.ts`
- Create: `e2e/device-firmware-download.spec.ts`
- Modify: `src/lib/storage.ts` (a `firmwareStore` reader)

**Interfaces:**
- Consumes: `firmwareReleases`, `requireDevice`.
- Produces: `GET /api/device/firmware/<version>` → the `.uf2` bytes. Task 8's simulated device downloads through it.

- [ ] **Step 1: Write the failing test**

Create `e2e/device-firmware-download.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, publishTestRelease, cleanupTestReleases } from './device-helpers';

test.afterAll(cleanupTestReleases);

test('an unpublished version is a 404, not a 403', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get('/api/device/firmware/9.9.9%2Bgnothere', {
    headers: authHeader(token),
  });
  // 404 so a caller learns nothing about what exists.
  expect(res.status()).toBe(404);
});

test('an anonymous caller cannot download firmware', async ({ request }) => {
  const res = await request.get('/api/device/firmware/1.0.0%2Bga111111');
  expect(res.status()).toBe(401);
});

test('a malformed version is refused before any lookup', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const res = await request.get('/api/device/firmware/not-a-version', {
    headers: authHeader(token),
  });
  expect(res.status()).toBe(400);
});
```

A test that downloads real bytes belongs in Task 8, where the simulated device
publishes a release whose blob actually exists; `publishTestRelease` records a
`blobPath` with no object behind it, so a 200-path assertion here would fail
for the wrong reason.

- [ ] **Step 2: Run test to verify it fails**

Run: `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/device-firmware-download.spec.ts`
Expected: FAIL — 404 for every case, because the route does not exist (so the 400 and 401 assertions fail).

- [ ] **Step 3: Add the store reader**

In `src/lib/storage.ts`, beside `diskStore`, add:

```ts
/**
 * Firmware images. Separate from diskStore because the key space is different
 * (a version string, not a digest) and the entitlement model is different --
 * firmware is global, disks belong to an org.
 *
 * Here rather than in the route for the reason stated at the top of this file:
 * this is the only module that may import @vercel/blob.
 */
export const firmwareStore = {
  async read(blobPath: string): Promise<Uint8Array> {
    const result = await get(blobPath);
    if (!result) throw new Error(`storage: could not read ${blobPath}`);
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },
};
```

Match the exact `get` usage of the existing `diskStore.read` — read it first and copy its shape rather than inventing one.

- [ ] **Step 4: Write the route**

Create `src/app/api/device/firmware/[version]/route.ts`:

```ts
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { firmwareStore } from '@/lib/storage';
import { FIRMWARE_VERSION_MAX } from '@/lib/firmware-version';

// A .uf2 is ~1 MB. Well inside the default, but stated for the same reason
// the image route states it.
export const maxDuration = 60;

export async function GET(
  request: Request,
  ctx: { params: Promise<{ version: string }> },
) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) {
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    throw e;
  }
  void device;   // authenticated is the whole check; see below

  const { version } = await ctx.params;
  if (!version || version.length > FIRMWARE_VERSION_MAX) {
    return Response.json({ error: 'bad_version' }, { status: 400 });
  }

  const [rel] = await getDb()
    .select({ blobPath: firmwareReleases.blobPath })
    .from(firmwareReleases)
    .where(eq(firmwareReleases.version, version))
    .limit(1);

  // 404, not 403: a caller learns nothing about which versions exist.
  //
  // Unlike the image route there is deliberately NO per-org entitlement check.
  // Firmware is a product artifact, global by design (increment 1, D5), and
  // every paired device is entitled to the firmware it was told to run. The
  // authentication above is the boundary.
  if (!rel) return Response.json({ error: 'not_found' }, { status: 404 });

  let bytes: Uint8Array;
  try {
    bytes = await firmwareStore.read(rel.blobPath);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    },
  });
}
```

The `400` must be checked before the lookup so a malformed version never
reaches the database, and `FIRMWARE_VERSION_MAX` is reused rather than a new
literal — the same constant the firmware's buffer is sized from.

- [ ] **Step 5: Run tests to verify they pass**

Run: `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/device-firmware-download.spec.ts`
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/app/api/device/firmware src/lib/storage.ts e2e/device-firmware-download.spec.ts
git commit -m "device: serve a published firmware image to an authenticated board"
```

---

### Task 6: The batch action, behind a password

**Files:**
- Create: `src/lib/step-up.ts`
- Create: `src/lib/firmware-update.ts`
- Create: `src/app/api/devices/firmware-update/route.ts`
- Create: `e2e/firmware-update-action.spec.ts`

**Interfaces:**
- Consumes: `refuseTarget` (Task 3), `listReleases`/`buildRegistry` (increment 1).
- Produces:
  ```ts
  export async function verifyPassword(email: string, password: string): Promise<boolean>;
  export type BatchRefusal = { deviceId: string; name: string; reason: TargetRefusal };
  export async function requestFirmwareUpdate(
    orgId: string, userId: string, deviceIds: string[], version: string,
  ): Promise<{ ok: true; count: number } | { ok: false; refusals: BatchRefusal[] }>;
  ```
  Task 7's dialog posts to the route.

- [ ] **Step 1: Write the failing test**

Create `e2e/firmware-update-action.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import {
  pairDevice, authHeader, publishTestRelease, cleanupTestReleases, cleanupSeeded,
} from './device-helpers';

test.afterAll(async () => { await cleanupTestReleases(); await cleanupSeeded(); });

/** Report a capability so the device is targetable at all. */
async function announceCapable(request: any, token: string, version: string) {
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: version, updateProtocol: 1 },
  });
}

test('a wrong password writes nothing', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  void password;
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.30+gaa30000');
  await publishTestRelease('0.0.0-e2e.31+gaa31000');
  await announceCapable(request, token, '0.0.0-e2e.30+gaa30000');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.31+gaa31000', password: 'wrong-password' },
  });
  expect(res.status()).toBe(401);

  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  if (poll.status() === 200) expect((await poll.json()).update).toBeUndefined();
});

/**
 * All-or-nothing. A multi-select that silently updated three of five would be
 * the worst outcome the batch could have.
 */
test('one refused device leaves the whole batch unwritten', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const a = await pairDevice(page, request, 'Able');
  const b = await pairDevice(page, request, 'Baker');
  await publishTestRelease('0.0.0-e2e.32+gaa32000');
  await publishTestRelease('0.0.0-e2e.33+gaa33000');
  await announceCapable(request, a.token, '0.0.0-e2e.32+gaa32000');
  // Baker never reports a capability, so it cannot be updated.

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [a.deviceId, b.deviceId], version: '0.0.0-e2e.33+gaa33000', password },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.refusals).toContainEqual(expect.objectContaining({ reason: 'cannot_update' }));

  // Able must be untouched despite passing its own checks.
  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(a.token) });
  if (poll.status() === 200) expect((await poll.json()).update).toBeUndefined();
});

test('a rollback is refused', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.34+gaa34000');
  await publishTestRelease('0.0.0-e2e.35+gaa35000');
  await announceCapable(request, token, '0.0.0-e2e.35+gaa35000');   // on the NEWER one

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.34+gaa34000', password },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).refusals[0].reason).toBe('would_roll_back');
});

test('a device in another org is a 404', async ({ page, request, browser }) => {
  const { password } = await signUpFresh(page);
  await publishTestRelease('0.0.0-e2e.36+gaa36000');

  const other = await browser.newPage();
  await signUpFresh(other);
  const stranger = await pairDevice(other, request, 'Stranger');
  await other.close();

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [stranger.deviceId], version: '0.0.0-e2e.36+gaa36000', password },
  });
  expect(res.status()).toBe(404);
});

/**
 * Standing down is not the privileged direction, so it takes no password. It
 * clears INTENT, not flash -- a board that already applied the update keeps it.
 */
test('cancelling clears a pending update, with no password', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.39a+gaa39a00');
  await publishTestRelease('0.0.0-e2e.39b+gaa39b00');
  await announceCapable(request, token, '0.0.0-e2e.39a+gaa39a00');

  await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.39b+gaa39b00', password },
  });
  const cancel = await page.request.delete('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId] },
  });
  expect(cancel.status()).toBe(200);

  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  if (poll.status() === 200) expect((await poll.json()).update).toBeUndefined();
});

test('a good batch sets the update and the device sees it', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.37+gaa37000');
  await publishTestRelease('0.0.0-e2e.38+gaa38000');
  await announceCapable(request, token, '0.0.0-e2e.37+gaa37000');

  const res = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version: '0.0.0-e2e.38+gaa38000', password },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).count).toBe(1);

  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).update.version).toBe('0.0.0-e2e.38+gaa38000');
});
```

`signUpFresh` must return the password it used. Read `e2e/helpers.ts` — if it
does not already, add it to the returned object; every other caller ignores
extra fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/firmware-update-action.spec.ts`
Expected: FAIL — the route 404s.

- [ ] **Step 3: Write the step-up check**

Create `src/lib/step-up.ts`:

```ts
import { auth } from '@/lib/auth';

/**
 * Re-verify the signed-in user's password.
 *
 * What this buys, precisely: it defends against a stolen session cookie --
 * someone with the operator's laptop cannot silently reflash their hardware --
 * and NOTHING else. A compromised server can skip the prompt entirely. It is
 * not a substitute for the image signature.
 *
 * Verified per request rather than by opening an elevated window, so there is
 * no window to time-box, leak, or forget to expire.
 */
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  try {
    // signInEmail mints a session as a side effect. That session is never
    // returned to the caller and never set as a cookie here -- this function
    // returns a boolean and nothing else -- so it is inert. CONFIRM THIS BY
    // RUNNING IT rather than from the types: if better-auth's version here
    // behaves differently, verify the stored credential directly instead of
    // bending the auth layer around this call.
    const result = await auth.api.signInEmail({ body: { email, password } });
    return Boolean(result);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write the batch rule**

Create `src/lib/firmware-update.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { listReleases } from '@/lib/firmware-releases';
import { buildRegistry } from '@/lib/firmware-state';
import { refuseTarget, type TargetRefusal } from '@/lib/firmware-update-rules';

export type BatchRefusal = { deviceId: string; name: string; reason: TargetRefusal };

export type BatchResult =
  | { ok: true; count: number }
  | { ok: false; kind: 'refused'; refusals: BatchRefusal[] }
  | { ok: false; kind: 'unknown_device' }
  | { ok: false; kind: 'unknown_version' };

/**
 * Point devices at a firmware release.
 *
 * ALL-OR-NOTHING. Every device is checked before any is written: a multi-select
 * that silently updated three of five would be the worst outcome it could have,
 * and the operator would have no way to tell which three.
 *
 * Note what is deliberately NOT a refusal: a mounted disk. Setting desired
 * firmware always succeeds, and the board applies it once nothing is mounted
 * (spec D2) -- the device enforces that itself, so the rule holds even when
 * this server is wrong about what is mounted.
 */
export async function requestFirmwareUpdate(
  orgId: string, userId: string, deviceIds: string[], version: string,
): Promise<BatchResult> {
  const db = getDb();

  const releases = await listReleases();
  const target = releases.find((r) => r.version === version);
  if (!target) return { ok: false, kind: 'unknown_version' };
  const reg = buildRegistry(releases);

  // Org-scoped in the statement. A device id alone is not enough to name a
  // device -- same rule setDesired already follows.
  const rows = await db
    .select({
      id: devices.id, name: devices.name,
      updateProtocol: devices.updateProtocol,
      firmwareVersion: devices.firmwareVersion,
    })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  // A device outside the org is indistinguishable from one that does not
  // exist. Never a 403.
  if (rows.length !== deviceIds.length) return { ok: false, kind: 'unknown_device' };

  const refusals: BatchRefusal[] = [];
  for (const d of rows) {
    const reason = refuseTarget(d, target, reg);
    if (reason) refusals.push({ deviceId: d.id, name: d.name, reason });
  }
  if (refusals.length > 0) return { ok: false, kind: 'refused', refusals };

  await db.update(devices)
    .set({
      desiredFirmwareVersion: target.version,
      desiredFirmwareSetAt: new Date(),
      desiredFirmwareSetByUserId: userId,
      // Cleared so the poll reads this as unacknowledged and releases its hold
      // once (spec 4.2). A leftover 'failed' from a previous attempt would
      // otherwise mean the device is never told about the new one.
      firmwareUpdateState: null,
      firmwareUpdateError: null,
    })
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  return { ok: true, count: rows.length };
}

/** Stand down. No password: this is not the privileged direction. */
export async function cancelFirmwareUpdate(
  orgId: string, deviceIds: string[],
): Promise<number> {
  const rows = await getDb().update(devices)
    .set({ desiredFirmwareVersion: null, desiredFirmwareSetAt: null,
           desiredFirmwareSetByUserId: null, firmwareUpdateState: null,
           firmwareUpdateError: null })
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)))
    .returning({ id: devices.id });
  return rows.length;
}
```

- [ ] **Step 5: Write the route**

Create `src/app/api/devices/firmware-update/route.ts`:

```ts
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { verifyPassword } from '@/lib/step-up';
import { requestFirmwareUpdate, cancelFirmwareUpdate } from '@/lib/firmware-update';
import { firmwareVersionSchema } from '@/lib/firmware-version';

const body = z.object({
  deviceIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  version: firmwareVersionSchema,
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const { orgId, userId, email } = await requireOrg();

  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  // BEFORE anything is read or written. A wrong password must leave no trace
  // and reveal nothing about which devices or versions exist.
  if (!(await verifyPassword(email, parsed.data.password))) {
    return Response.json({ error: 'bad_password' }, { status: 401 });
  }

  const result = await requestFirmwareUpdate(
    orgId, userId, parsed.data.deviceIds, parsed.data.version,
  );
  if (result.ok) return Response.json({ count: result.count });
  if (result.kind === 'unknown_device') return Response.json({ error: 'not_found' }, { status: 404 });
  if (result.kind === 'unknown_version') return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ error: 'refused', refusals: result.refusals }, { status: 409 });
}

const cancelBody = z.object({ deviceIds: z.array(z.string().min(1).max(64)).min(1).max(50) });

export async function DELETE(request: Request) {
  const { orgId } = await requireOrg();
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = cancelBody.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const count = await cancelFirmwareUpdate(orgId, parsed.data.deviceIds);
  return Response.json({ count });
}
```

`requireOrg()` must return `email`. Read `src/lib/session.ts` — if it does not,
add it from the session's user, which is already loaded there.

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm vitest run && pnpm build
PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/firmware-update-action.spec.ts
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git status --short
git add src/lib/step-up.ts src/lib/firmware-update.ts \
        src/app/api/devices/firmware-update e2e/firmware-update-action.spec.ts \
        src/lib/session.ts e2e/helpers.ts
git commit -m "devices: request a firmware update for several boards, behind a password"
```

---

### Task 7: The Devices UI

**Files:**
- Create: `src/components/devices/update-selection.tsx` (client: selection state, bar, dialog)
- Modify: `src/components/devices/device-card.tsx`
- Modify: `src/app/(app)/devices/page.tsx`
- Modify: `src/lib/queries.ts` (`DeviceListItem` + `listDevices`)
- Modify: `src/lib/firmware-state.ts` (`firmwareLabel` gains the update states)
- Modify: `src/lib/firmware-state.test.ts`
- Test: `e2e/devices-firmware.spec.ts`

**Interfaces:**
- Consumes: `refuseTarget` (Task 3) to decide whether to offer a checkbox.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing wording test**

Append to `src/lib/firmware-state.test.ts`:

```ts
describe('firmwareLabel with an update in flight', () => {
  it('says what is happening, and warns before a flash', () => {
    expect(updateLabel({ state: 'queued', mounted: true, target: '1.2.0+gc333333' }))
      .toBe('update queued — waiting for eject');
    expect(updateLabel({ state: 'queued', mounted: false, target: '1.2.0+gc333333' }))
      .toBe('update queued');
    expect(updateLabel({ state: 'downloading', mounted: false, target: '1.2.0+gc333333' }))
      .toBe('downloading 1.2.0+gc333333');
    expect(updateLabel({ state: 'applying', mounted: false, target: '1.2.0+gc333333' }))
      .toBe('applying 1.2.0+gc333333 — do not power off');
  });

  it('names the reason a failure gives, rather than just "failed"', () => {
    expect(updateLabel({ state: 'failed', mounted: false, target: '1.2.0+gc333333',
                         error: 'signature mismatch' }))
      .toBe('update failed — signature mismatch');
  });

  // The gap between the operator pressing Update and the board's next poll.
  it('says an update is requested before the board has said anything', () => {
    expect(updateLabel({ state: null, mounted: false, target: '1.2.0+gc333333' }))
      .toBe('update requested');
  });

  it('is null when nothing is wanted, so the card falls back to the plain line', () => {
    expect(updateLabel({ state: null, mounted: false, target: null })).toBeNull();
  });
});
```

Import `updateLabel` alongside the existing imports. It takes no `FirmwareState`:
an update in flight is described by the update's own fields, not by how far behind
the board was before it started.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/firmware-state.test.ts`
Expected: FAIL — `updateLabel is not a function`.

- [ ] **Step 3: Add the wording**

In `src/lib/firmware-state.ts`, beside `firmwareLabel`:

```ts
/**
 * How an update IN FLIGHT is worded. Null when none is wanted, in which case
 * the card shows the plain firmware line instead.
 *
 * Here rather than in the component, for the same reason firmwareLabel is:
 * the wording is then covered by vitest rather than only by a full Playwright
 * run, and the card and any future surface cannot drift on what these mean.
 */
export function updateLabel(
  u: { state: string | null; mounted: boolean; target: string | null; error?: string | null },
): string | null {
  if (!u.target) return null;
  switch (u.state) {
    // The device enforces the mount rule itself, so this is reporting what the
    // board decided, not what the server hopes.
    case 'queued': return u.mounted ? 'update queued — waiting for eject' : 'update queued';
    case 'downloading': return `downloading ${u.target}`;
    case 'applying': return `applying ${u.target} — do not power off`;
    case 'failed': return `update failed — ${u.error ?? 'reason not reported'}`;
    default: return 'update requested';
  }
}
```

- [ ] **Step 4: Carry the new columns to the page**

In `src/lib/queries.ts`, add to `DeviceListItem` and to `listDevices`'s select:

```ts
  updateProtocol: number | null;
  desiredFirmwareVersion: string | null;
  firmwareUpdateState: string | null;
  firmwareUpdateError: string | null;
```

- [ ] **Step 5: Render it on the card**

In `src/components/devices/device-card.tsx`, import `updateLabel` and compute:

```tsx
  // An update in flight replaces the firmware line; there is no value in
  // saying "2 releases behind" to someone watching it download.
  const update = updateLabel({
    state: device.firmwareUpdateState,
    mounted: device.mountedSha256 !== null,
    target: device.desiredFirmwareVersion,
    error: device.firmwareUpdateError,
  });
```

and render `{update ?? firmwareLabel(firmware)}` in the existing
`device-firmware-<id>` span. Colour it `var(--amber-text)` when `update` is
non-null or the state is `behind`, as now.

- [ ] **Step 6: Write the selection UI**

Read `src/components/disks/history-panel.tsx` FIRST for this repo's modal
portal pattern and copy it rather than introducing a second one.

Create `src/components/devices/update-selection.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ReleaseRef } from '@/lib/firmware-state';

export interface Selectable { id: string; name: string; firmwareVersion: string | null }

export function UpdateSelection(
  { selectable, latest }: { selectable: Selectable[]; latest: ReleaseRef },
) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<{ name: string; reason: string }[]>([]);

  const chosen = selectable.filter((d) => picked.has(d.id));
  if (selectable.length === 0) return null;

  async function confirm() {
    setBusy(true);
    setRefusals([]);
    try {
      const res = await fetch('/api/devices/firmware-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceIds: chosen.map((d) => d.id), version: latest.version, password,
        }),
      });
      if (res.status === 401) { toast.error('That password was not right.'); return; }
      if (res.status === 409) { setRefusals((await res.json()).refusals); return; }
      if (!res.ok) { toast.error('Could not request the update.'); return; }
      toast.success(`Update requested for ${chosen.length} device${chosen.length === 1 ? '' : 's'}.`);
      setOpen(false);
      setPicked(new Set());
      setPassword('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* One checkbox per selectable device, rendered by the page into each
          card via this component's toggle -- see the page wiring below. */}
      {picked.size > 0 && (
        <div className="glass-card flex flex-wrap items-center gap-3 p-4" data-testid="update-bar">
          <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
            {picked.size} selected · Update to{' '}
            {/* The full version, never the semver: two releases can share one. */}
            <strong className="break-all font-mono">{latest.version}</strong>
          </span>
          <button data-testid="update-start" onClick={() => setOpen(true)}
                  className="rounded-full px-4 py-1.5 text-[13px] font-semibold"
                  style={{ background: 'var(--amber-text)', color: '#16273a' }}>
            Update
          </button>
          <button onClick={() => setPicked(new Set())}
                  className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Clear
          </button>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgb(0 0 0 / 0.5)' }} data-testid="update-dialog">
          <div className="glass-card flex w-full max-w-lg flex-col gap-3 p-6">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              Update {chosen.length} device{chosen.length === 1 ? '' : 's'}
            </h2>
            <ul className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
              {chosen.map((d) => (
                <li key={d.id} className="break-all font-mono">
                  {d.name} · {d.firmwareVersion ?? 'version unknown'} → {latest.version}
                </li>
              ))}
            </ul>
            {latest.security && (
              <span className="text-[12px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--amber-text)' }}>Security release</span>
            )}
            {latest.notes && (
              <p className="text-[13px]" style={{ color: 'var(--ink)' }}>{latest.notes}</p>
            )}
            {/* Said plainly rather than discovered afterwards. */}
            <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
              A board holding a disk will wait until it is ejected before applying this.
            </p>
            <label className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
              Confirm with your password
              <input type="password" data-testid="update-password" value={password}
                     onChange={(e) => setPassword(e.target.value)}
                     className="rounded-lg px-3 py-2 text-[13px]"
                     style={{ background: 'var(--input-bg)', color: 'var(--ink)' }} />
            </label>
            {refusals.length > 0 && (
              <ul className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--amber-text)' }}>
                {refusals.map((r) => <li key={r.name}>{r.name}: {r.reason.replace(/_/g, ' ')}</li>)}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="text-[13px]"
                      style={{ color: 'var(--muted)' }}>Cancel</button>
              <button data-testid="update-confirm" disabled={busy || password.length === 0}
                      onClick={confirm}
                      className="rounded-full px-4 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--amber-text)', color: '#16273a' }}>
                {busy ? 'Requesting…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function useUpdateSelection() { /* see the page wiring note below */ }
```

**Page wiring.** The checkbox lives on the card but the selection state lives
here, so lift it: have `DevicesPage` compute the selectable list and render
`<UpdateSelection …>` above the cards, and pass each card an
`onToggle`/`selected` pair from the same state. The simplest shape that avoids
prop-drilling through a server component is to make the whole card list a small
client wrapper; read how `src/components/library/` already splits its
server-rendered rows from client selection before choosing.

Each checkbox carries `data-testid={`device-select-${device.id}`}` and is
rendered ONLY when `refuseTarget(d, latest, registry) === null` — the same
function the route rejects with, so the UI can never offer what the server
refuses.

- [ ] **Step 7: Write the e2e**

Append to `e2e/devices-firmware.spec.ts`:

```ts
test('a board that cannot update gets no checkbox', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.40+gaa40000');
  await report(request, token, '0.0.0-e2e.40+gaa40000');   // no updateProtocol

  await page.goto('/devices');
  await expect(page.getByTestId(`device-select-${deviceId}`)).toHaveCount(0);
});

test('a capable board behind the newest release can be selected and updated', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  await publishTestRelease('0.0.0-e2e.41+gaa41000');
  await publishTestRelease('0.0.0-e2e.42+gaa42000');
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0-e2e.41+gaa41000', updateProtocol: 1 },
  });

  await page.goto('/devices');
  await page.getByTestId(`device-select-${deviceId}`).check();
  await expect(page.getByTestId('update-bar')).toContainText('1 selected');
  await page.getByTestId('update-start').click();
  await page.getByTestId('update-password').fill(password);
  await page.getByTestId('update-confirm').click();

  await expect(page.getByTestId(`device-firmware-${deviceId}`))
    .toContainText('update requested');
});
```

- [ ] **Step 8: Run tests**

```bash
pnpm vitest run && pnpm build
PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e e2e/devices-firmware.spec.ts
```
Expected: green.

- [ ] **Step 9: Commit**

```bash
git status --short
git add src/components/devices src/app/\(app\)/devices/page.tsx src/lib/queries.ts \
        src/lib/firmware-state.ts src/lib/firmware-state.test.ts e2e/devices-firmware.spec.ts
git commit -m "devices: select boards and update them, with the version named and the password asked"
```

---

### Task 8: Liveness, the whole loop, and the handoff

**Files:**
- Modify: `src/lib/live-state.ts`, `src/lib/live-state.test.ts`
- Modify: `src/app/api/live-state/route.ts`
- Create: `e2e/firmware-update-loop.spec.ts`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Put the update into the fingerprint**

`desiredFirmwareVersion` and `firmwareUpdateState` change what `/devices`
renders, so they belong in `liveFingerprint`'s line — add both to
`LiveStateRow`, to `liveStateRows`'s select, and to the joined line. Increment
1 shipped with exactly this gap for the registry and it had to be fixed in
review; do not repeat it.

Add to `src/lib/live-state.test.ts`:

```ts
it('changes when an update is requested or its state moves', () => {
  const pending = { ...base, desiredFirmwareVersion: '1.2.0+gc333333', firmwareUpdateState: null };
  const downloading = { ...pending, firmwareUpdateState: 'downloading' };
  expect(fp([base])).not.toBe(fp([pending]));
  expect(fp([pending])).not.toBe(fp([downloading]));
});
```

- [ ] **Step 2: Write the whole-loop e2e**

Create `e2e/firmware-update-loop.spec.ts`. This is the test that matters — a
simulated device driven through every step the real protocol defines:

```ts
test('the whole loop: request, poll, download, apply, verify', async ({ page, request }) => {
  const { password } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  // A release whose blob actually exists, so the download returns bytes.
  const version = await publishTestReleaseWithBlob('0.0.0-e2e.50+gaa50000');
  await publishTestRelease('0.0.0-e2e.49+gaa49000');   // an older one to sit on
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '0.0.0-e2e.49+gaa49000', updateProtocol: 1 },
  });

  // 1. The operator asks.
  const ask = await page.request.post('/api/devices/firmware-update', {
    data: { deviceIds: [deviceId], version, password },
  });
  expect(ask.status()).toBe(200);

  // 2. The device polls and is told.
  const poll = await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
  const instruction = (await poll.json()).update;
  expect(instruction.version).toBe(version);

  // 3. It downloads through the real route.
  const dl = await request.get(`/api/device/firmware/${encodeURIComponent(version)}`,
                               { headers: authHeader(token) });
  expect(dl.status()).toBe(200);
  expect((await dl.body()).byteLength).toBe(instruction.sizeBytes);

  // 4. It reports progress.
  for (const state of ['downloading', 'applying'] as const) {
    await request.post('/api/device/status', {
      headers: authHeader(token), data: { mountedSha256: null, firmwareUpdateState: state },
    });
  }

  // 5. It comes back running the new version. Nothing says "succeeded".
  await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: version, updateProtocol: 1 },
  });

  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('up to date');
});
```

Add `publishTestReleaseWithBlob` to `e2e/device-helpers.ts`. Unlike
`publishTestRelease`, this one puts real bytes in the store so the download
route can return them:

```ts
/**
 * A seeded release whose blob actually exists. publishTestRelease records a
 * blobPath with no object behind it, which is fine for the UI specs and
 * useless for the download path.
 */
export async function publishTestReleaseWithBlob(version: string): Promise<string> {
  if (!version.startsWith(E2E_RELEASE_PREFIX)) {
    throw new Error(`e2e releases must start with ${E2E_RELEASE_PREFIX}, got ${version}`);
  }
  const { put } = await import('@vercel/blob');
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from(`e2e firmware ${version}`);
  const blobPath = `firmware/${version}.uf2`;
  await put(blobPath, bytes, {
    access: 'private', contentType: 'application/octet-stream',
    addRandomSuffix: false, allowOverwrite: true,
  });
  seededFirmwareBlobs.push(blobPath);

  const db = getDb();
  const rows = await db.select({ sequence: firmwareReleases.sequence }).from(firmwareReleases);
  const sequence = rows.reduce((m, r) => (r.sequence > m ? r.sequence : m), 0) + 1;
  await db.insert(firmwareReleases).values({
    id: randomUUID(), version, semver: '0.0.0', sequence,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength, blobPath,
    signature: 'ZTJlLXRlc3Q=', signingKeyId: 'e2e', notes: null,
    security: false, publishedByUserId: 'e2e',
  }).onConflictDoNothing();
  return version;
}
```

`allowOverwrite: true` here specifically, because a previous run's object may
survive and the fixture must be re-runnable — the same reasoning that gave
`publishTestRelease` its `onConflictDoNothing`.

Add a module-level `const seededFirmwareBlobs: string[] = []` beside the other
`seeded` state, and extend `cleanupTestReleases` to `del()` each one before it
deletes the rows — an orphaned firmware blob in the operator's private store is
exactly the kind of leftover this suite's teardown exists to prevent.

- [ ] **Step 3: Run the gates**

```bash
pnpm vitest run
pnpm build
PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e
```
Expected: all green, and the teardown reports zero leftover firmware releases.

- [ ] **Step 4: Write the HANDOFF section**

Add a numbered section in the style of §3ai. Record: what shipped, the gate
numbers, that **no firmware implements the protocol** and every test drives a
simulated device, the hold-release rule and why `desiredVersion` is not bumped,
and what increment 2b owes.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/live-state.ts src/lib/live-state.test.ts src/app/api/live-state/route.ts \
        e2e/firmware-update-loop.spec.ts e2e/device-helpers.ts HANDOFF.md
git commit -m "HANDOFF: the server half of firmware updates"
```

---

## Before merging

1. `pnpm vitest run` — report the count.
2. `pnpm build` — clean.
3. `pnpm firmware:test` — unchanged by this plan, but report it.
4. `PORT=4100 BASE_URL=http://localhost:4100 pnpm e2e` — the **full** suite, foreground.
5. **A whole-branch review**, on the strongest model, with the composition questions given explicitly. Five branches in this repo have had Criticals that only this pass found.
6. Confirm the teardown left no seeded releases: `select count(*) from firmware_releases where version like '0.0.0-e2e%'` must be 0.
7. Re-run `git status` before staging; never `git add -A` while `wifi-floppy/` is dirty.
