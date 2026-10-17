# PaulaNET Phase 4, increment 3: the web sends, the driver disk carries Receive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person sends files to their Amiga from the web app (a file from the computer, a file or folder from a
library disk, a whole disk as `.adf`), watches each one wait, move, arrive or fail, and finds `Receive` on the
PaulaNET driver disk; a rebooted board can reach an idle Amiga again.

**Architecture:**
- **Pairing asks for the board's name** (spec §4 "Board names"): kept on the pairing code, written by `register`;
  empty keeps the `Device <MAC>` label.
- **Shared rules** (`src/lib/send-limits.ts`, `src/lib/send-ui.ts`): pure, client-safe; every word the UI shows
  about a transfer, a board or the receiver comes from here.
- **Server:** reads over the increment-2 `transfers` table (`listTransfers`, `queueLoad`, `retryTransfer`,
  `sendSummaries`), the board list a person may send to (`listSendTargets`, fw ≥ `XFER_FW`), and five user routes
  under `/api/transfers`.
- **Web:**
  - the Upload page in two columns ("Add to library" unchanged, "Send to Amiga" new), self-refreshing every 3 s;
  - a Send button on every file-tree row and a "Send .adf to Amiga" button on every ADF disk row, with one shared
    board choice remembered in the browser;
  - one line on the board's card, linking to the queue.
- **The driver disk:** `Receive` and its icon go onto it, `Install` copies them, `ReadMe` explains them. The disk's
  digest changes. Boards whose Amiga is online keep the old disk until the Amiga is off, so DF1 never changes under
  a running driver.
- **The IP gap (HANDOFF 3bu):** the server remembers the Amiga's last address (`devices.net_amiga_ip_last`) and
  sends it as `xfer.ip`. Firmware 1.16.0 (master's next minor, released together with the LZ4 driver work) seeds the sorter with it when it knows none, and the board's own connect
  attempt (ARP over the local path) is the probe.

**Tech Stack:** Next.js 16 route handlers and server components, React 19 client components, drizzle +
node-postgres, vitest (+ `test:db`), Playwright (desktop and mobile projects), sonner toasts; amitools `xdftool`,
AmigaDOS script; RP2350 firmware C with its host-test harness.

**Spec:** `docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` (§4 "Server and web", §5
"Build" and "`Install`", §6 increment 3, §7 "e2e" and "A500 bench"). Increments 1 (`Receive`, HANDOFF 3bt) and 2
(queue, routes, firmware 1.14.0, released as 1.15.0 after the MFM fix, HANDOFF 3bu; plan
`docs/superpowers/plans/2026-10-16-paulanet-phase4-board-and-queue.md`) are merged.

## Global Constraints

- **Limits, unchanged from spec D4:** 4 MB per file (`SEND_FILE_MAX = 4_194_304`); at most 32 waiting files or
  16 MB per board; waiting files expire after 24 h; finished rows are kept for 7 days.
- **The firmware gate is 1.15.0** (`XFER_FW`), not the spec's 1.14.0. See ruling R1.
- **D8:** nothing is overwritten and nothing leaves the folder. The server cleans names (`cleanAmigaPath`) and
  `Receive` checks them again. The protocol (spec §2) is not changed.
- **Self-hosting has full parity.** Nothing here may depend on Vercel or on our deployment: same limits, same
  routes, the driver disk built into the image, the cron already in `vercel.ts` for the self-host scheduler.
- **Copy:** plain and short, in the repo's tone. Every state is stated in words, both values of it ("Receive is
  running" / "Start Receive on the Amiga"); an absent icon is never a reading. Amber text uses `--amber-text`,
  never `--accent-amber`.
- **Phone width:** every new surface works at 390 px with no sideways page scroll; long paths wrap
  (`overflow-wrap: anywhere`).
- **Help text** in `src/lib/help/topics.tsx` changes with the code it describes, and it never names internal words
  (`poll`, `cursor`, `sha256`, `PSRAM`).
- **Next.js 16:** before writing a page or a route handler, read the matching guide in `node_modules/next/dist/docs/`
  (AGENTS.md). Route files export only handlers and route config; shared helpers live in `src/lib/`.
- **lint:** `react-hooks/set-state-in-effect` and render purity are on: no synchronous `setState` in an effect
  body, no `Date.now()` during render in a client component (the server passes `now`).
- **e2e:** PORT=3100, one run at a time, each foreground command under 9 minutes, only the touched specs; it runs
  against the live production database (teardown by email domain); wait for the teardown line before the next run.
- **Firmware versions:** a fix is a patch (1.11.1, 1.12.1), a feature the next minor; `FIRMWARE_SEMVER` is bumped in
  the commit that starts a release's work (1.14.0 was set by increment 2's firmware task), and every build is told
  apart by `+g<sha>`. **Operator 2026-10-17: the IP fix is not released on its own; it ships in 1.16.0 with the LZ4
  driver work** (R18). Task 12 sets master's `FIRMWARE_SEMVER` to `1.16.0`; bench builds are TEST builds of master
  (`1.16.0+g<sha>`) whose notes MUST start with exactly `TEST build` (the release visibility rule, HANDOFF 3bu
  incident); check that after publishing. Promoting firmware is not part of this increment.
- **Production:** `.env.local` holds production secrets: never print them. **Approved by the operator for this
  increment (2026-10-17):** the migrations to production (0041 pairing name, 0042 Amiga address; both additive), the
  driver-disk upload, and merging to master and pushing (it deploys). Firmware installs on the bench board follow
  memory "Firmware installs authorized"; firmware promotion is not part of this increment. The operator powers the
  Amiga and types on it: ask as the last thing in a turn.
- **Git:** work in worktree `.claude/worktrees/send-web` on branch `feat/send-web` (set up as memory "Worktree setup
  for e2e" says: real `pnpm install --offline`, `.env.local`, `pnpm exec next typegen`, the `adf-archive` symlink).
  Never `git stash`, never `git add -A`. Every commit message ends with the session's attribution lines.

**Rulings made while writing this plan** (spec gaps or deviations; the executor carries them):
- **R1: `XFER_FW = '1.15.0'`.** 1.14.0 only ever existed as TEST and debug builds (registry seq 86-94), and its
  frames to the Amiga stall the link (HANDOFF 3bu). Offering a 1.14.0 board would offer a send that freezes.
  Cost if wrong: a 1.14.0 board is not listed until it updates.
- **R2: bytes stay in `diskStore` (`adf/<sha>`),** as increment 2 ruled, not the spec's `transfers/<sha>`.
- **R3: Browse → Send is a Send button per row** (a file, or a folder with everything in it), not a multi-select.
  The file tree has no selection today, and it is a drag-and-drop tree with inline forms. Cost if wrong: a later
  select mode; the route already takes a list of blocks.
- **R4: paths from a disk are relative to the chosen entry's parent:** a folder arrives under its own name
  (`mods/axelf.mod`), a file by its name. Empty folders are not sent (Receive makes folders from file paths).
- **R5: protection bits are the low eight (`hsparwed`):** `AdfEntry` carries only the string. The rare group bits
  are lost.
- **R6: "Receive is running" means contact within 75 s,** not the spec's 60. The board writes `rx` at most every
  30 s and polls every 25 s, so a healthy reading can be 56 s old. A row in `sending` also counts: the board does not
  poll while a file moves.
- **R7: "long offline" is 24 h,** the waiting-file lifetime: a board offline longer cannot take a file before it
  expires. Such boards sit behind "Show offline".
- **R8: pairing asks for a name** (spec §4 "Board names"; operator 2026-10-17). Optional, trimmed, at most 80
  characters (the rename limit); kept on the pairing code and written by `register`. Empty means the existing
  `Device <MAC>` label, so a board is never nameless and "Name it" still applies. The selector also hides long-offline
  rows. Task 1.
- **R9: Cancel is offered on `sending` as well as `queued`.** The board then gets 409 on its next chunk and aborts
  (increment 2). The bench asks for "cancel mid-file".
- **R10: Retry is offered on `failed` and `expired`,** and it queues a new row. The old row stays, as history.
- **R11: the card's "recent" means finished within 24 h.**
- **R12: the card line follows spec §4** (one line, no queue of its own), not §6's shorthand "the queue on the card".
- **R13: the upload is a raw body** (`POST /api/transfers?deviceId=&name=`), not multipart. 4 MB plus headers is under
  Vercel's 4.5 MB body limit, and a raw body needs no parser.
- **R14: the committed binary.** `tools/receive/dist/Receive` is committed, pinned by `receive.sha256`, and CI checks
  that a fresh cross-build is identical. The disk build and the self-host image use it. A Docker stage of the amd64
  compiler image would need emulation on the arm64 image runner (image.yml builds natively per arch). Cost if wrong:
  23,840 bytes in git.
- **R15: `Receive.info` reuses Rob's tool picture,** as `Install.info` and `ReadMe.info` already do.
- **R16: the driver-disk rollout.** The old digest stays valid (served, kept by GC, shown as "the older one"). The
  poll keeps naming the old disk to a board that holds it while the Amiga's driver talks (within 120 s), and names the
  new one otherwise. The existing 5-minute re-arm (`netNextRearm`) re-wakes such a board, so the new disk goes in
  within minutes of the Amiga being switched off, never under a running driver.
- **R17: the IP gap is fixed by the server's memory, not flash.** A flash write needs an idle Amiga (motor off for
  `SWAP_IDLE_MS`, `drive_store_idle`), and Network mode's driver reads the drive ~48 times a second, so the write
  would almost never run, and never before an Amiga-powered board loses power. The server already hears the address
  in every status report; it keeps the last one in a column of its own, because `net_amiga_ip` is cleared when a
  report lacks it (the card must not show a stale address). A broadcast ping was rejected: whether AmiTCP or Roadshow
  answer one is unknown.
- **R18: the firmware half ships in 1.16.0** (operator 2026-10-17), with the LZ4 driver variant. The server half
  (0042, `xfer.ip`) ships now: 1.14.0 and 1.15.0 ignore `ip` and keep their 48-byte buffer (Review Focus 4).

## Review Focus

1. **A remembered board that no longer qualifies** (deleted, re-paired as a new row, or showing old firmware after a
   failed update). The browser must fall back to a current target, and the server must refuse a stale id. It must
   never queue for a board that cannot take files. *Pinned in Task 2 (`pickTarget` with a stale id) and Task 4
   (POST for a 1.13.0 board → 404).*
2. **A cancel that loses the race with delivery.** The person presses Cancel as the board posts `OK`. The row must
   end Delivered, the UI must say "Already finished", and no row may read Cancelled for a file that arrived. *Pinned
   in Task 4 (DELETE → 409) and Task 6 (e2e: a cancel after delivery is refused and the row stays Delivered; the
   panel turns that 409 into the "Already finished" toast).*
3. **A folder that would overflow the queue** (33 files, or more than 16 MB with what is already waiting). Nothing
   may be queued half-way, and the message must say why. *Pinned in Task 4 (from-disk with a 31-file load → 409,
   nothing queued).*
4. **A 1.14.0 or 1.15.0 board receiving the new `xfer.ip`.** Those builds copy `xfer` into a 48-byte buffer, and an
   object that does not fit makes them drop `xfer` whole, which would stop every send. *Pinned in Task 11 (the worst
   `xfer` object is under 48 bytes).*
5. **A phone with a 200-byte saved path and a long board name.** The two columns must stack, the path must wrap,
   and nothing may scroll sideways. *Pinned in Task 6 (mobile e2e).*

---

## File structure

```
src/db/schema/devices.ts, drizzle/0041_*.sql   pairing_codes.name
src/lib/device-name.ts (+ test)           pairingName, nameForNewBoard
src/app/api/devices/pair/route.ts, src/app/api/device/register/route.ts   the name, stored and used
src/components/devices/pair-button.tsx    the name field
e2e/pairing.spec.ts, e2e/devices-page.spec.ts, e2e/device-helpers.ts   pairing e2e
src/lib/send-limits.ts                    XFER_FW and the D4 limits; no imports (client-safe)
src/lib/send-ui.ts (+ .test.ts)           targets, receiver line, transfer states, card line, names, error words
src/lib/transfers.ts                      + queueLoad, listTransfers, retryTransfer, sendSummaries; bytes option
src/lib/transfers.db.test.ts              + cases
src/lib/send-targets.ts                   listSendTargets, findSendTarget, loadSendDisk (db)
src/lib/send-targets.db.test.ts
src/lib/send-from-disk.ts (+ .test.ts)    protectionBits, pickFiles (pure)
src/lib/send-http.ts                      queueResponse, toView
src/app/api/transfers/route.ts            GET the board's queue + receiver; POST a file
src/app/api/transfers/[id]/route.ts       DELETE = cancel
src/app/api/transfers/[id]/retry/route.ts POST = queue again
src/app/api/transfers/from-disk/route.ts  POST files/folders or the whole ADF of a library disk
src/app/api/transfers/routes.test.ts
src/lib/help/topics.tsx (+ test)          topic `send`
src/components/send/use-send-board.ts     the remembered board choice
src/components/send/send-panel.tsx        the Upload page's right column
src/components/send/send-button.tsx       useSendAction, SendBoardPicker, SendAdfButton
src/app/(app)/ingest/page.tsx             two columns
src/components/ingest/dropzone.tsx        one margin class
src/components/disks/file-tree.tsx        Send on each row
src/app/(app)/disks/[id]/files/page.tsx   targets, picker
src/components/games/disk-row.tsx, disk-set-section.tsx, src/app/(app)/games/[id]/page.tsx   Send .adf
src/components/devices/device-card.tsx, device-list.tsx, src/app/(app)/devices/page.tsx      the card line
src/lib/live-state.ts (+ test)            sendVersion, sendRx in the fingerprint
e2e/send-to-amiga.spec.ts                 new; e2e/mobile.spec.ts + one test
tools/receive/dist/Receive                committed pinned binary (R14); .github/workflows/receive.yml + cmp
tools/paulanet-disk/{build.sh,make_icon.py,check.py,Install,ReadMe,paulanet-disk.sha256}
docker/Dockerfile                         the paulanet stage takes Receive
src/lib/paulanet-disk.ts (+ test), src/lib/network-checklist.ts (+ test), src/lib/mount.ts,
src/app/api/device/poll/route.ts (+ test) the rollout (R16) and xfer.ip (R17)
src/db/schema/devices.ts, drizzle/0042_*.sql   net_amiga_ip_last
src/lib/mount-record-status.test.ts, src/lib/device-limits.test.ts
wifi-floppy/firmware/src/{pnet_sort.c,.h, pnet_bridge.c,.h, device_client.c,.h, main.c}, CMakeLists.txt (1.16.0)
wifi-floppy/firmware/test/{test_pnet_sort.c, test_device_client.c}
```

---

### Task 1: Pairing asks for a board name

**Files:**
- Modify: `src/db/schema/devices.ts:251-258` (`pairingCodes.name`); Generate: `drizzle/0041_pairing_name.sql` (+ journal, snapshot)
- Modify: `src/lib/device-name.ts`, `src/lib/device-name.test.ts`
- Modify: `src/app/api/devices/pair/route.ts`; Create: `src/app/api/devices/pair/route.test.ts`
- Modify: `src/app/api/device/register/route.ts:64-101`
- Modify: `src/app/api/devices/[id]/route.ts:13` (the rename limit becomes the shared constant)
- Modify: `src/components/devices/pair-button.tsx`
- Modify: `src/lib/help/topics.tsx` (`boards`, the Pairing paragraph), `src/lib/help/topics.test.ts`
- Modify: `e2e/device-helpers.ts:32` and `:546` (`pairDevice`, `df1OnBoard`), `e2e/pairing.spec.ts`, `e2e/devices-page.spec.ts:395-425`

**Interfaces:**
- Consumes: `defaultDeviceName` (`src/lib/device-name.ts`).
- Produces (exact):

```ts
// src/lib/device-name.ts
export const DEVICE_NAME_MAX = 80;   // the rename limit (src/app/api/devices/[id]/route.ts), now shared
export function pairingName(input: string | null | undefined): string | null;
export function nameForNewBoard(pairName: string | null, macAddress: string | null): string;
```

  - `pairing_codes.name text` (null = none given); `POST /api/devices/pair` `{ name?: string }` (trimmed, at most 80
    characters, else 400 `{error:'invalid_body'}`); `register` names the device `nameForNewBoard(code.name, mac)`.
  - Test ids: `pair-device` (opens the form; unchanged id), `pair-name`, `pair-submit`, `pair-cancel`,
    `pairing-code`, `pairing-for`.
  - e2e: `pairDevice(page, request, name?)`: `name` omitted sends `{}`, so the board wears `Device <MAC>` exactly as
    before (device-alias.spec.ts depends on it); a name given is now kept (later tasks pair as `'Bench'`).

- [ ] **Step 1: Write the failing unit tests.** Append to `src/lib/device-name.test.ts` (and import
  `pairingName, nameForNewBoard, DEVICE_NAME_MAX`):

```ts
describe('a name given at pairing (plan 2026-10-17 Task 1, R8)', () => {
  it('is trimmed and loses control characters; empty means none', () => {
    expect(pairingName('  A500 study  ')).toBe('A500 study');
    expect(pairingName('A\u0000B\nC')).toBe('ABC');
    expect(pairingName('   ')).toBeNull();
    expect(pairingName(undefined)).toBeNull();
    expect(pairingName(null)).toBeNull();
  });
  it('names the new board, or it wears its MAC as before', () => {
    expect(nameForNewBoard('A500 study', MAC)).toBe('A500 study');
    expect(nameForNewBoard(null, MAC)).toBe(`Device ${MAC}`);
  });
  it('shares the rename limit', () => {
    expect(DEVICE_NAME_MAX).toBe(80);
  });
});
```

  Create `src/app/api/devices/pair/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
let inserted: Record<string, unknown>[] = [];
vi.mock('@/db', () => ({ getDb: () => ({
  insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return {
    onConflictDoNothing: () => ({ returning: async () => [{ code: v.code }] }) }; } }),
}) }));

const post = (body: unknown) => new Request('http://test/api/devices/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { inserted = []; });

describe('POST /api/devices/pair', () => {
  it('keeps the trimmed name on the code', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ name: '  A500 study ' }));
    expect(res.status).toBe(200);
    expect(inserted[0]).toMatchObject({ orgId: 'org-1', createdByUserId: 'user-1', name: 'A500 study' });
  });
  it('stores no name for an empty or missing one (the board then wears its MAC)', async () => {
    const { POST } = await import('./route');
    await POST(post({ name: '   ' }));
    await POST(post({}));
    expect(inserted.map((v) => v.name)).toEqual([null, null]);
  });
  it('refuses a name over 80 characters rather than cutting it', async () => {
    const { POST } = await import('./route');
    const res = await POST(post({ name: 'x'.repeat(81) }));
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/device-name.test.ts src/app/api/devices/pair/route.test.ts`
Expected: FAIL: `pairingName is not a function`; the pair route stores no `name` and accepts 81 characters.

- [ ] **Step 3: Implement the names.** Append to `src/lib/device-name.ts`:

```ts
/** The longest name a board may carry: the rename route's limit, shared with pairing (plan 2026-10-17 R8). */
export const DEVICE_NAME_MAX = 80;

/** A name typed when pairing, as stored on the code: trimmed, no control characters; empty means none. The caller
 *  has already refused one over DEVICE_NAME_MAX. */
export function pairingName(input: string | null | undefined): string | null {
  const s = (input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s === '' ? null : s;
}

/** What register names a new board: the name given at pairing, else the MAC label it has always worn. */
export function nameForNewBoard(pairName: string | null, macAddress: string | null): string {
  return pairName ?? defaultDeviceName(macAddress);
}
```

  In `src/app/api/devices/[id]/route.ts`, `z.string().trim().max(80)` becomes `z.string().trim().max(DEVICE_NAME_MAX)`
  (import it from `@/lib/device-name`).

- [ ] **Step 4: Store it on the code.** In `src/db/schema/devices.ts`, `pairingCodes` gains after `createdByUserId`:

```ts
  /** The board's name as typed when the code was minted (plan 2026-10-17 R8); null = none given. register uses it. */
  name: text('name'),
```

Run: `pnpm db:generate --name pairing_name && cat drizzle/0041_pairing_name.sql`
Expected: `ALTER TABLE "pairing_codes" ADD COLUMN "name" text;`

  In `src/app/api/devices/pair/route.ts`: import `{ DEVICE_NAME_MAX, pairingName } from '@/lib/device-name'`; replace
  the comment above `pairBody` and the schema with:

```ts
// The board's name, typed before the code is shown (plan 2026-10-17 R8). Kept on the code; register names the board
// with it. Optional: none (or only spaces) means the board wears its MAC, as it always has. Over the rename limit is a
// 400, never a silent cut.
const pairBody = z.object({
  name: z.string().trim().max(DEVICE_NAME_MAX).optional(),
});
```

  and the insert's values become `{ code, orgId, createdByUserId: userId, expiresAt, name: pairingName(parsed.data.name) }`.
  The 400 answer becomes `Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 })`
  (the repo's shape, as `register` and the rename route answer).

  In `src/app/api/device/register/route.ts`: the import `defaultDeviceName` becomes `nameForNewBoard`; the claim's
  `.returning({ orgId: pairingCodes.orgId })` becomes `.returning({ orgId: pairingCodes.orgId, name: pairingCodes.name })`;
  `const { orgId } = claimed[0];` becomes `const { orgId, name: pairName } = claimed[0];`; and the name block becomes:

```ts
  // The name typed when the code was minted (plan 2026-10-17 R8), else the one identifying detail the board supplies
  // about itself. nameForNewBoard falls back to defaultDeviceName -- the label an alias reset restores.
  const name = nameForNewBoard(pairName, parsed.data.macAddress);
```

- [ ] **Step 5: Run the unit tests to see them pass**

Run: `pnpm vitest run src/lib/device-name.test.ts src/app/api/devices/pair/route.test.ts src/app/api/devices/[id]/route.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, tsc 0.

- [ ] **Step 6: Write the failing e2e.** In `e2e/device-helpers.ts`, `pairDevice`'s signature becomes
  `export async function pairDevice(page: Page, request: APIRequestContext, name?: string) {` and its first line
  `const pair = await page.request.post('/api/devices/pair', { data: name === undefined ? {} : { name } });`;
  `df1OnBoard`'s `name = 'Test Device'` becomes `name?: string`. In `e2e/pairing.spec.ts`, the first test gains, after
  `expect(deviceId).toBeTruthy();`:

```ts
  // The name typed at pairing is the board's name (plan 2026-10-17 R8).
  expect((await reg.json()).name).toBe('Living Room');
```

  (read the JSON once: `const regBody = await reg.json(); const { token, deviceId } = regBody;` and assert
  `regBody.name`), and add:

```ts
test('a code minted without a name gives the board its MAC label, and an over-long name is refused', async ({ page, request }) => {
  await signUpFresh(page);
  const { code } = await (await page.request.post('/api/devices/pair', { data: {} })).json();
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '2.1.0', macAddress: 'AA:BB:CC:DD:EE:01' },
  });
  expect((await reg.json()).name).toBe('Device AA:BB:CC:DD:EE:01');
  expect((await page.request.post('/api/devices/pair', { data: { name: 'x'.repeat(81) } })).status()).toBe(400);
});
```

  In `e2e/devices-page.spec.ts`, the expiry test's click becomes the two-step flow, and a new test follows it:

```ts
  const [pairResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/devices/pair') && r.request().method() === 'POST'),
    (async () => { await page.getByTestId('pair-device').click(); await page.getByTestId('pair-submit').click(); })(),
  ]);
```

```ts
test('pairing asks for a name, shows it with the code, and the paired board wears it', async ({ page, request }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await page.getByTestId('pair-device').click();
  await expect(page.getByTestId('pair-name')).toBeFocused();
  await page.getByTestId('pair-name').fill('A500 in the study');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/devices/pair') && r.request().method() === 'POST'),
    page.getByTestId('pair-submit').click(),
  ]);
  const { code } = await res.json();
  await expect(page.getByTestId('pairing-for')).toHaveText('for A500 in the study');
  const reg = await request.post('/api/device/register', {
    data: { pairingCode: code, firmwareVersion: '1.15.0', macAddress: 'AA:BB:CC:DD:EE:02' },
  });
  const { deviceId } = await reg.json();
  await page.goto('/devices');
  await expect(page.getByTestId(`device-name-${deviceId}`)).toHaveText('A500 in the study');
  await getDb().delete(devices).where(eq(devices.id, deviceId));
});

test('Cancel closes the pairing form without minting a code', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/devices');
  await page.getByTestId('pair-device').click();
  await page.getByTestId('pair-cancel').click();
  await expect(page.getByTestId('pair-name')).toHaveCount(0);
  await expect(page.getByTestId('pair-device')).toBeVisible();
});
```

  (`devices` and `eq` join the spec's imports from `@/db/schema/devices` and `drizzle-orm` if missing.)

- [ ] **Step 7: Apply migration 0041 to production** (approved 2026-10-17; additive, one nullable column on
  `pairing_codes`). The e2e and production `register` read the column from here on. Say so in the conversation,
  then: `pnpm db:migrate`. Expected: `0041_pairing_name` applied. (Production keeps working before the deploy: the old
  code never names the column.)

- [ ] **Step 8: Run the e2e to see it fail**

Run: `PORT=3100 pnpm exec playwright test e2e/pairing.spec.ts e2e/devices-page.spec.ts --project=desktop > /tmp/e2e-pair.log 2>&1; tail -15 /tmp/e2e-pair.log`
Expected: the name test, the cancel test and the expiry test fail on `pair-name` / `pair-submit` not found
(pairing.spec.ts already passes: Steps 3-4 made the routes keep the name).

- [ ] **Step 9: The form.** Replace `src/components/devices/pair-button.tsx` with:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEVICE_NAME_MAX } from '@/lib/device-name';

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pair a device: first the board's name (plan 2026-10-17 R8 -- boards that all read "Device <MAC>" made every picker
 * ambiguous), then the code. The name is optional: left empty, the board wears its MAC as before and can be named on
 * its card later.
 */
export function PairButton() {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (naming) input.current?.focus(); }, [naming]);

  // Ticks the countdown once a second while a code is live (as before).
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => setRemainingMs(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // A code that has hit zero is removed rather than left greyed out (as before).
  useEffect(() => {
    if (code !== null && remainingMs === 0) {
      setCode(null);
      setExpiresAt(null);
      setExpired(true);
    }
  }, [code, remainingMs]);

  async function mint() {
    setBusy(true);
    setExpired(false);
    const typed = name.trim();
    try {
      let res: Response;
      try {
        res = await fetch('/api/devices/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(typed ? { name: typed } : {}),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
        return;
      }
      if (!res.ok) {
        toast.error('Could not mint a pairing code', { description: `The server answered ${res.status}.` });
        return;
      }
      const body = await res.json();
      const expiresAtMs = new Date(body.expiresAt).getTime();
      setPairedName(typed || null);
      setNaming(false);
      setCode(body.code);
      setExpiresAt(expiresAtMs);
      setRemainingMs(expiresAtMs - Date.now());
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <div className="flex flex-col items-end gap-1" data-testid="pairing-code">
        <span className="font-mono text-[20px] font-bold tracking-[0.14em]"
              style={{ color: 'var(--on-dark)' }}>{code}</span>
        {pairedName && (
          <span className="max-w-[60vw] text-right text-[11px]" data-testid="pairing-for"
                style={{ color: 'var(--on-dark-muted)', overflowWrap: 'anywhere' }}>for {pairedName}</span>
        )}
        <span className="text-[11px]" data-testid="pairing-expiry" style={{ color: 'var(--on-dark-muted)' }}>
          {remainingMs === null ? 'enter this on the device' : `expires in ${formatRemaining(remainingMs)}`}
        </span>
      </div>
    );
  }

  if (naming) {
    return (
      <form className="flex flex-col items-end gap-1" onSubmit={(e) => { e.preventDefault(); void mint(); }}>
        <label className="flex flex-col items-end gap-1 text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          Name this board
          <input ref={input} value={name} maxLength={DEVICE_NAME_MAX} data-testid="pair-name"
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') setNaming(false); }}
                 placeholder="e.g. A500 in the study"
                 className="w-[min(240px,60vw)] rounded-lg border bg-transparent px-2 py-1 text-[12.5px]"
                 style={{ borderColor: 'var(--hairline-strong)', color: 'var(--on-dark)' }} />
        </label>
        <span className="text-[10.5px]" style={{ color: 'var(--on-dark-muted)' }}>Leave it empty to name it by its MAC address.</span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setNaming(false)} data-testid="pair-cancel"
                  className="rounded-lg px-3 py-2 text-[12.5px] font-semibold" style={{ color: 'var(--on-dark)' }}>
            Cancel
          </button>
          <button type="submit" disabled={busy} data-testid="pair-submit"
                  className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--primary-action)' }}>
            {busy ? 'Minting…' : 'Get a code'}
          </button>
        </div>
      </form>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          Code expired
        </span>
        <button type="button" onClick={() => void mint()} disabled={busy} data-testid="pair-device"
                className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--primary-action)' }}>
          {busy ? 'Minting…' : 'Mint a new code'}
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => { setName(''); setNaming(true); }} data-testid="pair-device"
            className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white"
            style={{ background: 'var(--primary-action)' }}>
      Pair a device
    </button>
  );
}
```

  "Mint a new code" re-mints with the same name (the form is not shown again).

- [ ] **Step 10: Help says it.** In `topics.tsx`'s `boards` body, the Pairing paragraph's first sentence becomes:
  `<strong>Pairing.</strong> Press <em>Pair a device</em>, give the board a name (or leave it empty to name it by its
  MAC address), and press <em>Get a code</em>.` (the rest of the paragraph unchanged), and the source comment above
  `boards` gains `Naming at pairing: pair-button.tsx, api/devices/pair + device/register (plan 2026-10-17 R8).`
  In `topics.test.ts`, the `boards gives the setup network password…` test gains
  `expect(b).toMatch(/give the board a name/);`.

- [ ] **Step 11: Run everything for this task**

Run: `pnpm vitest run src/lib/help src/lib/device-name.test.ts src/app/api/devices && pnpm exec tsc --noEmit && pnpm lint`
then `PORT=3100 pnpm exec playwright test e2e/pairing.spec.ts e2e/devices-page.spec.ts e2e/device-alias.spec.ts --project=desktop > /tmp/e2e-pair.log 2>&1; tail -15 /tmp/e2e-pair.log`
and, after the teardown line, `PORT=3100 pnpm exec playwright test e2e/game-detail.spec.ts e2e/second-drive.spec.ts e2e/help.spec.ts --project=desktop > /tmp/e2e-pair2.log 2>&1; tail -15 /tmp/e2e-pair2.log`
(these pass names to `pairDevice` / `df1OnBoard`, which are now kept).
Expected: vitest PASS, tsc 0, lint clean, e2e 0 failed in both runs.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema/devices.ts drizzle/0041_pairing_name.sql drizzle/meta src/lib/device-name.ts src/lib/device-name.test.ts \
        src/app/api/devices/pair/route.ts src/app/api/devices/pair/route.test.ts src/app/api/device/register/route.ts \
        "src/app/api/devices/[id]/route.ts" src/components/devices/pair-button.tsx src/lib/help/topics.tsx \
        src/lib/help/topics.test.ts e2e/device-helpers.ts e2e/pairing.spec.ts e2e/devices-page.spec.ts
git commit -m "pairing asks for the board's name (optional, 80 characters); register names the board with it (migration 0041)"
```

---

### Task 2: The shared send rules

**Files:**
- Create: `src/lib/send-limits.ts`, `src/lib/send-ui.ts`, `src/lib/send-ui.test.ts`
- Modify: `src/lib/transfers.ts:8-11` (the four constants move to `send-limits.ts` and are re-exported)

**Interfaces:**
- Consumes: `TransferStatus` (type only) from `@/lib/transfers`.
- Produces (exact):

```ts
// send-limits.ts
export const XFER_FW = '1.15.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
// send-ui.ts
export type Rx = 'c' | 'r' | 'u' | '-';
export const RX_FRESH_MS = 75_000;
export const LONG_OFFLINE_MS = 24 * 3600_000;
export const SEND_BOARD_KEY = 'webadf:send-board';
export type SendTarget = { id: string; name: string; macAddress: string | null; defaultName: boolean;
  online: boolean; lastSeenAt: number | null; network: boolean; rx: Rx | null; rxAt: number | null };
export type SendContext = { targets: SendTarget[]; now: number };
export type TransferView = { id: string; path: string; sizeBytes: number; status: TransferStatus; bytesSent: number;
  savedAs: string | null; errorCode: string | null; errorText: string | null; createdAt: number; finishedAt: number | null };
export type Tone = 'ok' | 'busy' | 'bad' | 'muted';
export type SendSummary = { waiting: number; sending: number; delivered: number; failed: number };
export function failureText(code: string | null, text: string | null): string;
export function transferState(t: TransferView): { text: string; tone: Tone };
export function canCancel(s: TransferStatus): boolean;
export function canRetry(s: TransferStatus): boolean;
export function receiverRunning(t: Pick<SendTarget, 'rx' | 'rxAt'>, sending: boolean, now: number): boolean;
export function receiverLine(t: SendTarget, q: { waiting: number; sending: boolean }, now: number): { ok: boolean; text: string };
export function offlineFor(ms: number): string;
export function targetState(t: SendTarget, now: number): string;
export function longOffline(t: SendTarget, now: number): boolean;
export function orderTargets(ts: readonly SendTarget[]): SendTarget[];
export function pickTarget(ts: readonly SendTarget[], wanted: string | null, now: number): string | null;
export function cardSendLine(s: SendSummary | undefined, running: boolean): string | null;
export function adfSendName(d: { tosecName: string | null; sourceFilename: string | null; diskNo: number }): string;
export function sendErrorText(code: string | undefined, status: number): string;
export function formatSize(n: number): string;
```

- [ ] **Step 1: Write the failing test** `src/lib/send-ui.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  adfSendName, canCancel, canRetry, cardSendLine, failureText, formatSize, longOffline, offlineFor, orderTargets,
  pickTarget, receiverLine, receiverRunning, sendErrorText, targetState, transferState,
  type SendTarget, type TransferView,
} from './send-ui';

const NOW = 1_800_000_000_000;
const t = (over: Partial<SendTarget> = {}): SendTarget => ({
  id: 'a', name: 'Bench', macAddress: '28:CD:C1:19:6A:38', defaultName: false, online: true,
  lastSeenAt: NOW - 5_000, network: true, rx: 'c', rxAt: NOW - 10_000, ...over,
});
const row = (over: Partial<TransferView> = {}): TransferView => ({
  id: 'x', path: 'Café.lha', sizeBytes: 1000, status: 'queued', bytesSent: 0, savedAs: null, errorCode: null,
  errorText: null, createdAt: NOW, finishedAt: null, ...over,
});

describe('transfer states, each in words', () => {
  it('names every status', () => {
    expect(transferState(row()).text).toBe('Waiting');
    expect(transferState(row({ status: 'sending', bytesSent: 500 })).text).toBe('Sending 50 %');
    expect(transferState(row({ status: 'sending', bytesSent: 1000 })).text).toBe('Sending 99 %');
    expect(transferState(row({ status: 'delivered', savedAs: 'Café_2.lha' })).text).toBe('Delivered · saved as Café_2.lha');
    expect(transferState(row({ status: 'failed', errorCode: 'space', errorText: 'disk full' })).text)
      .toBe('Failed · not enough space on the Amiga');
    expect(transferState(row({ status: 'cancelled' })).text).toBe('Cancelled');
    expect(transferState(row({ status: 'expired' })).text).toBe('Expired · the Amiga did not take it within 24 h');
  });
  it('falls back to Receive\'s own text for a code it does not know', () => {
    expect(failureText('odd', 'something broke')).toBe('something broke');
    expect(failureText(null, null)).toBe('unknown reason');
  });
  it('offers Cancel while waiting or moving, Retry once it failed or expired', () => {
    expect(['queued', 'sending'].every((s) => canCancel(s as never))).toBe(true);
    expect(['delivered', 'failed', 'cancelled', 'expired'].some((s) => canCancel(s as never))).toBe(false);
    expect(canRetry('failed') && canRetry('expired')).toBe(true);
    expect(canRetry('cancelled') || canRetry('delivered')).toBe(false);
  });
});

describe('the receiver line', () => {
  it('says running only for a fresh connected reading, or while a file moves (R6)', () => {
    expect(receiverRunning(t(), false, NOW)).toBe(true);
    expect(receiverRunning(t({ rxAt: NOW - 80_000 }), false, NOW)).toBe(false);
    expect(receiverRunning(t({ rxAt: NOW - 80_000 }), true, NOW)).toBe(true);
    expect(receiverRunning(t({ rx: 'r' }), true, NOW)).toBe(false);
  });
  it('names the reason in words, most basic first', () => {
    const q = { waiting: 0, sending: false };
    expect(receiverLine(t({ online: false }), q, NOW)).toEqual({ ok: false, text: 'The board is offline. Files wait until it is back.' });
    expect(receiverLine(t({ network: false }), q, NOW).text).toBe('The board is not in Network mode. Files wait until it is.');
    expect(receiverLine(t(), q, NOW)).toEqual({ ok: true, text: 'Receive is running on the Amiga' });
    expect(receiverLine(t({ rx: '-' }), q, NOW).text).toBe('The board has not seen the Amiga on the network yet');
    expect(receiverLine(t({ rx: null }), q, NOW).text).toBe('The board has not seen the Amiga on the network yet');
    expect(receiverLine(t({ rx: 'r' }), { waiting: 2, sending: false }, NOW).text).toBe('Start Receive on the Amiga');
    expect(receiverLine(t({ rx: 'r' }), q, NOW).text).toBe('Receive is not running on the Amiga');
    expect(receiverLine(t({ rx: 'u' }), q, NOW).text).toBe('The Amiga does not answer');
  });
});

describe('boards to send to', () => {
  it('says online, or how long offline', () => {
    expect(targetState(t(), NOW)).toBe('online');
    expect(targetState(t({ online: false, lastSeenAt: NOW - 7 * 3600_000 }), NOW)).toBe('offline 7 h');
    expect(targetState(t({ online: false, lastSeenAt: null }), NOW)).toBe('never seen');
    expect(offlineFor(30 * 60_000)).toBe('30 min');
    expect(offlineFor(5 * 86_400_000)).toBe('5 days');
  });
  it('puts online boards first, then by name; long offline is over 24 h (R7)', () => {
    const ts = [t({ id: 'z', name: 'Zed', online: false }), t({ id: 'b', name: 'Beta' }), t({ id: 'a', name: 'Alpha' })];
    expect(orderTargets(ts).map((x) => x.id)).toEqual(['a', 'b', 'z']);
    expect(longOffline(t({ online: false, lastSeenAt: NOW - 25 * 3600_000 }), NOW)).toBe(true);
    expect(longOffline(t({ online: false, lastSeenAt: NOW - 3600_000 }), NOW)).toBe(false);
  });
  it('keeps a wanted board only while it is still a target (Review Focus 1)', () => {
    const ts = [t({ id: 'old', name: 'Old', online: false, lastSeenAt: NOW - 30 * 86_400_000 }), t({ id: 'new', name: 'New' })];
    expect(pickTarget(ts, 'old', NOW)).toBe('old');
    expect(pickTarget(ts, 'deleted-board', NOW)).toBe('new');
    expect(pickTarget(ts, null, NOW)).toBe('new');
    expect(pickTarget([], 'new', NOW)).toBeNull();
    expect(pickTarget([ts[0]], null, NOW)).toBe('old');
  });
});

describe('the card line and names', () => {
  it('counts what waits and what happened, and always says whether Receive runs', () => {
    expect(cardSendLine(undefined, true)).toBeNull();
    expect(cardSendLine({ waiting: 0, sending: 0, delivered: 0, failed: 0 }, true)).toBeNull();
    expect(cardSendLine({ waiting: 3, sending: 0, delivered: 1, failed: 0 }, true)).toBe('3 files waiting · Receive running');
    expect(cardSendLine({ waiting: 1, sending: 1, delivered: 0, failed: 1 }, false))
      .toBe('1 file waiting · 1 sending · 1 failed · Receive not running');
    expect(cardSendLine({ waiting: 0, sending: 0, delivered: 2, failed: 0 }, false)).toBe('2 delivered · Receive not running');
  });
  it('names a whole disk <name>.adf, whatever it was uploaded as', () => {
    expect(adfSendName({ tosecName: 'Lotus (1990)(Gremlin).adf', sourceFilename: 'x.dms', diskNo: 1 })).toBe('Lotus (1990)(Gremlin).adf');
    expect(adfSendName({ tosecName: null, sourceFilename: 'Turrican.DMS', diskNo: 2 })).toBe('Turrican.adf');
    expect(adfSendName({ tosecName: null, sourceFilename: null, diskNo: 3 })).toBe('Disk 3.adf');
  });
  it('turns every refusal into a sentence', () => {
    expect(sendErrorText('too_large', 413)).toBe('Over 4 MB: too large to send.');
    expect(sendErrorText('queue_full', 409)).toMatch(/32 files or 16 MB/);
    expect(sendErrorText(undefined, 502)).toBe('The server answered 502.');
  });
  it('sizes read as B, KB, MB', () => {
    expect(formatSize(44)).toBe('44 B');
    expect(formatSize(901_120)).toBe('880 KB');
    expect(formatSize(4_194_304)).toBe('4.0 MB');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/send-ui.test.ts`
Expected: FAIL, `Failed to resolve import "./send-ui"`.

- [ ] **Step 3: Write `src/lib/send-limits.ts`**

```ts
/**
 * Limits shared by the server's send queue and the browser (spec 2026-10-16 D4; the gate is ruling R1 of plan
 * 2026-10-17: 1.14.0 builds stall the link, HANDOFF 3bu). No imports, so client components can use it.
 */
export const XFER_FW = '1.15.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
```

In `src/lib/transfers.ts`, replace

```ts
export const XFER_FW = '1.14.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
```

with

```ts
import { XFER_FW, SEND_FILE_MAX, SEND_QUEUE_MAX_FILES, SEND_QUEUE_MAX_BYTES } from '@/lib/send-limits';
export { XFER_FW, SEND_FILE_MAX, SEND_QUEUE_MAX_FILES, SEND_QUEUE_MAX_BYTES };
```

(move the `import` line up with the other imports).

- [ ] **Step 4: Write `src/lib/send-ui.ts`**

```ts
import type { TransferStatus } from '@/lib/transfers';
import { SEND_FILE_MAX } from '@/lib/send-limits';

// Every word the web app says about sending to the Amiga (spec 2026-10-16 §4; plan 2026-10-17). Pure and
// client-safe: the type import above is erased, so nothing server-side reaches the bundle.

export type Rx = 'c' | 'r' | 'u' | '-';
/** R6: the board writes rx at most every 30 s and polls every 25 s, so a healthy reading can be ~56 s old. */
export const RX_FRESH_MS = 75_000;
/** R7: a board offline longer than a waiting file lives is behind "Show offline". */
export const LONG_OFFLINE_MS = 24 * 3600_000;
export const SEND_BOARD_KEY = 'webadf:send-board';

export type SendTarget = {
  id: string; name: string; macAddress: string | null; defaultName: boolean;
  online: boolean; lastSeenAt: number | null; network: boolean; rx: Rx | null; rxAt: number | null;
};
export type SendContext = { targets: SendTarget[]; now: number };
export type TransferView = {
  id: string; path: string; sizeBytes: number; status: TransferStatus; bytesSent: number;
  savedAs: string | null; errorCode: string | null; errorText: string | null; createdAt: number; finishedAt: number | null;
};
export type Tone = 'ok' | 'busy' | 'bad' | 'muted';
export type SendSummary = { waiting: number; sending: number; delivered: number; failed: number };

// Receive's error codes (spec §2), as a person would say them.
const REASONS: Record<string, string> = {
  space: 'not enough space on the Amiga',
  crc: 'damaged on the way',
  name: 'the Amiga refused the name',
  write: 'could not write it on the Amiga',
  folder: 'the folder on the Amiga is missing',
  busy: 'Receive was busy',
  size: 'too large for Receive',
};

export function failureText(code: string | null, text: string | null): string {
  if (code && REASONS[code]) return REASONS[code];
  return text?.trim() || code || 'unknown reason';
}

export function transferState(t: TransferView): { text: string; tone: Tone } {
  switch (t.status) {
    case 'queued': return { text: 'Waiting', tone: 'busy' };
    case 'sending': {
      // bytes_sent is the last chunk's offset, one chunk behind (increment 2): never 100 % before Delivered.
      const pct = t.sizeBytes > 0 ? Math.min(99, Math.floor((t.bytesSent * 100) / t.sizeBytes)) : 0;
      return { text: `Sending ${pct} %`, tone: 'busy' };
    }
    case 'delivered': return { text: `Delivered · saved as ${t.savedAs ?? t.path}`, tone: 'ok' };
    case 'failed': return { text: `Failed · ${failureText(t.errorCode, t.errorText)}`, tone: 'bad' };
    case 'cancelled': return { text: 'Cancelled', tone: 'muted' };
    case 'expired': return { text: 'Expired · the Amiga did not take it within 24 h', tone: 'bad' };
  }
}

export const canCancel = (s: TransferStatus): boolean => s === 'queued' || s === 'sending';   // R9
export const canRetry = (s: TransferStatus): boolean => s === 'failed' || s === 'expired';   // R10

export function receiverRunning(t: Pick<SendTarget, 'rx' | 'rxAt'>, sending: boolean, now: number): boolean {
  return t.rx === 'c' && (sending || (t.rxAt !== null && now - t.rxAt <= RX_FRESH_MS));
}

export function receiverLine(t: SendTarget, q: { waiting: number; sending: boolean }, now: number): { ok: boolean; text: string } {
  if (!t.online) return { ok: false, text: 'The board is offline. Files wait until it is back.' };
  if (!t.network) return { ok: false, text: 'The board is not in Network mode. Files wait until it is.' };
  if (receiverRunning(t, q.sending, now)) return { ok: true, text: 'Receive is running on the Amiga' };
  if (t.rx === null || t.rx === '-') return { ok: false, text: 'The board has not seen the Amiga on the network yet' };
  if (q.waiting > 0) return { ok: false, text: 'Start Receive on the Amiga' };
  if (t.rx === 'u') return { ok: false, text: 'The Amiga does not answer' };
  return { ok: false, text: 'Receive is not running on the Amiga' };
}

export function offlineFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function targetState(t: SendTarget, now: number): string {
  if (t.online) return 'online';
  return t.lastSeenAt === null ? 'never seen' : `offline ${offlineFor(now - t.lastSeenAt)}`;
}

export function longOffline(t: SendTarget, now: number): boolean {
  return !t.online && (t.lastSeenAt === null || now - t.lastSeenAt > LONG_OFFLINE_MS);
}

export function orderTargets(ts: readonly SendTarget[]): SendTarget[] {
  return [...ts].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The wanted board while it is still a target; else the first online one; else the first one; else none. */
export function pickTarget(ts: readonly SendTarget[], wanted: string | null, now: number): string | null {
  if (wanted && ts.some((t) => t.id === wanted)) return wanted;
  const ordered = orderTargets(ts);
  return ordered.find((t) => !longOffline(t, now))?.id ?? ordered[0]?.id ?? null;
}

export function cardSendLine(s: SendSummary | undefined, running: boolean): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.waiting) parts.push(`${s.waiting} ${s.waiting === 1 ? 'file' : 'files'} waiting`);
  if (s.sending) parts.push('1 sending');                // one file moves at a time
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.delivered && !s.waiting && !s.sending) parts.push(`${s.delivered} delivered`);
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} · Receive ${running ? 'running' : 'not running'}`;
}

export function adfSendName(d: { tosecName: string | null; sourceFilename: string | null; diskNo: number }): string {
  const base = (d.tosecName ?? d.sourceFilename ?? '').replace(/\.(adf|adz|dms|dmz|hfe)$/i, '').trim();
  return `${base || `Disk ${d.diskNo}`}.adf`;
}

export function sendErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case 'too_large': return `Over ${SEND_FILE_MAX / 1_048_576} MB: too large to send.`;
    case 'queue_full': return 'The queue for this board is full (32 files or 16 MB). Wait for some to arrive.';
    case 'bad_name': return 'That name cannot be used on the Amiga.';
    case 'empty': return 'The file is empty.';
    case 'no_device': return 'That board cannot receive files.';
    case 'not_waiting': return 'Already finished.';
    case 'unreadable': return 'A file on this disk could not be read whole.';
    case 'no_filesystem': return 'This disk has no files to send.';
    case 'not_adf': return 'Only ADF disks can be sent whole.';
    case 'gone': return 'The file is no longer stored. Send it again.';
    default: return `The server answered ${status}.`;
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
```

- [ ] **Step 5: Run it to see it pass, and nothing else moved**

Run: `pnpm vitest run src/lib/send-ui.test.ts src/lib/transfers.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (both files), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/send-limits.ts src/lib/send-ui.ts src/lib/send-ui.test.ts src/lib/transfers.ts
git commit -m "send: the shared words and limits for sending to the Amiga; XFER_FW is 1.15.0 (R1)"
```

---

### Task 3: Server reads, targets and disk files

**Files:**
- Modify: `src/lib/transfers.ts` (bytes option; `queueLoad`, `listTransfers`, `retryTransfer`, `sendSummaries`)
- Modify: `src/lib/transfers.db.test.ts` (new cases)
- Create: `src/lib/send-targets.ts`, `src/lib/send-targets.db.test.ts`
- Create: `src/lib/send-from-disk.ts`, `src/lib/send-from-disk.test.ts`

**Interfaces:**
- Consumes: Task 2's `SendTarget`, `SendSummary`, `Rx`, `orderTargets`, `XFER_FW`; `firmwareAtLeast`
  (`@/lib/firmware-version`), `isOnline` (`@/lib/device-state`), `isDefaultDeviceName` (`@/lib/device-name`),
  `protectionString` (`@/lib/adffs/dir`) in the test.
- Produces (exact):

```ts
// transfers.ts
queueTransferFromBlob(db, a: { ...as before; bytes?: Uint8Array }): Promise<QueueResult>;   // bytes: skips the re-read
export async function queueLoad(db: Db, deviceId: string): Promise<{ files: number; bytes: number }>;
export type TransferRow = typeof transfers.$inferSelect;
export async function listTransfers(db: Db, orgId: string, deviceId: string, limit?: number): Promise<TransferRow[]>;
export async function retryTransfer(db: Db, a: { orgId: string; userId: string; id: string; now?: Date }):
  Promise<QueueResult | { ok: false; reason: 'not_found' | 'not_finished' }>;
export async function sendSummaries(db: Db, orgId: string, now?: Date): Promise<Record<string, SendSummary>>;
// send-targets.ts
export async function listSendTargets(db: Db, orgId: string, now?: number): Promise<SendTarget[]>;
export async function findSendTarget(db: Db, orgId: string, deviceId: string, now?: number): Promise<SendTarget | null>;
export type SendDisk = { sha256: string; imageFormat: string; tosecName: string | null; sourceFilename: string | null; diskNo: number };
export async function loadSendDisk(db: Db, orgId: string, diskId: string): Promise<SendDisk | null>;
// send-from-disk.ts
export function protectionBits(s: string): number;
export type PickedFile = { block: number; path: string; protection: number; comment: string; sizeBytes: number };
export function pickFiles(root: AdfEntry[], blocks: readonly number[]): PickedFile[];
```

- [ ] **Step 1: Write the failing pure test** `src/lib/send-from-disk.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { protectionString } from '@/lib/adffs/dir';
import type { AdfEntry } from '@/lib/adffs';
import { pickFiles, protectionBits } from './send-from-disk';

const f = (block: number, name: string, protection = '----rwed', comment: string | null = null): AdfEntry =>
  ({ block, name, kind: 'file', sizeBytes: 10, modifiedAt: null, protection, comment, children: [] });
const d = (block: number, name: string, children: AdfEntry[]): AdfEntry =>
  ({ block, name, kind: 'dir', sizeBytes: 0, modifiedAt: null, protection: '----rwed', comment: null, children });

const tree = [d(10, 'mods', [f(11, 'axelf.mod', '-s--rwed', 'by Harold'), d(12, 'empty', []), d(13, 'more', [f(14, 'b.mod')])]),
  f(20, 'Readme')];

describe('protectionBits', () => {
  it('reads back exactly what protectionString wrote (R5: the low eight bits)', () => {
    for (const bits of [0, 0x01, 0x0f, 0x40, 0xf0, 0xff, 0x4d]) expect(protectionBits(protectionString(bits))).toBe(bits);
  });
  it('treats anything that is not an hsparwed string as no bits', () => {
    expect(protectionBits('rwed')).toBe(0);
  });
});

describe('pickFiles', () => {
  it('a file arrives by its own name, a folder under its own name with everything in it (R4)', () => {
    expect(pickFiles(tree, [20]).map((p) => p.path)).toEqual(['Readme']);
    expect(pickFiles(tree, [11]).map((p) => p.path)).toEqual(['axelf.mod']);
    expect(pickFiles(tree, [10]).map((p) => p.path)).toEqual(['mods/axelf.mod', 'mods/more/b.mod']);
    expect(pickFiles(tree, [13]).map((p) => p.path)).toEqual(['more/b.mod']);
  });
  it('carries protection and comment, skips empty folders, and never sends a file twice', () => {
    const [ax] = pickFiles(tree, [10]);
    expect(ax).toMatchObject({ block: 11, protection: 0x40, comment: 'by Harold', sizeBytes: 10 });
    expect(pickFiles(tree, [12])).toEqual([]);
    expect(pickFiles(tree, [10, 11]).map((p) => p.block)).toEqual([11, 14]);
  });
  it('finds nothing for a block that is not in the tree', () => {
    expect(pickFiles(tree, [999])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/send-from-disk.test.ts`
Expected: FAIL, `Failed to resolve import "./send-from-disk"`.

- [ ] **Step 3: Write `src/lib/send-from-disk.ts`**

```ts
import type { AdfEntry } from '@/lib/adffs';

/** The inverse of adffs's protectionString ("hsparwed"; rwed SET means forbidden). R5: the low eight bits only. */
export function protectionBits(s: string): number {
  if (!/^[h-][s-][p-][a-][r-][w-][e-][d-]$/.test(s)) return 0;
  let b = 0;
  const high = [0x80, 0x40, 0x20, 0x10];
  const low = [0x08, 0x04, 0x02, 0x01];
  high.forEach((m, i) => { if (s[i] !== '-') b |= m; });
  low.forEach((m, i) => { if (s[4 + i] === '-') b |= m; });
  return b;
}

export type PickedFile = { block: number; path: string; protection: number; comment: string; sizeBytes: number };

/**
 * The files to send for the chosen entries (spec §4 "the disk Browse page"; R4): a file by its own name, a folder
 * under its own name with every file inside it, in tree order. Empty folders send nothing; a file chosen both on its
 * own and inside a chosen folder is sent once.
 */
export function pickFiles(root: AdfEntry[], blocks: readonly number[]): PickedFile[] {
  const want = new Set(blocks);
  const seen = new Set<number>();
  const out: PickedFile[] = [];
  const addAll = (e: AdfEntry, prefix: string) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.kind === 'file') {
      if (seen.has(e.block)) return;
      seen.add(e.block);
      out.push({ block: e.block, path, protection: protectionBits(e.protection), comment: e.comment ?? '', sizeBytes: e.sizeBytes });
      return;
    }
    for (const c of e.children) addAll(c, path);
  };
  const walk = (entries: AdfEntry[]) => {
    for (const e of entries) {
      if (want.has(e.block)) addAll(e, '');
      else if (e.kind === 'dir') walk(e.children);
    }
  };
  walk(root);
  return out;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run src/lib/send-from-disk.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing db tests.** Append to `src/lib/transfers.db.test.ts`, inside `describe('transfers', ...)`
  (it already has `device`, `blob`, `q`, `row`, `version`):

```ts
  it('takes the bytes it is given instead of reading the blob again', async () => {
    const d = await device(); const b = new TextEncoder().encode('given');
    const r = await T.queueTransferFromBlob(getDb(), { orgId: 'org-a', deviceId: d, userId: 'u1', path: 'G', sha256: await blob(b), bytes: b });
    expect((await row((r as { id: string }).id)).crc32).toBe(crc32(b) >>> 0);
  });

  it('queueLoad counts what waits or moves, not what finished', async () => {
    const d = await device();
    const a = await q(d, await blob(new Uint8Array(100)));
    await q(d, await blob(new Uint8Array(200)));
    await T.finishTransfer(getDb(), d, (a as { id: string }).id, { ok: true, savedAs: 'File.bin' });
    expect(await T.queueLoad(getDb(), d)).toEqual({ files: 1, bytes: 200 });
  });

  it('listTransfers is this org\'s rows for the board, newest first', async () => {
    const d = await device();
    await q(d, await blob(new Uint8Array([1])), { path: 'first' });
    await q(d, await blob(new Uint8Array([2])), { path: 'second' });
    expect((await T.listTransfers(getDb(), 'org-a', d)).map((r) => r.path)).toEqual(['second', 'first']);
    expect(await T.listTransfers(getDb(), 'org-b', d)).toEqual([]);
  });

  it('retryTransfer queues a failed or expired row again as a new row, and refuses the rest', async () => {
    const d = await device();
    const r = await q(d, await blob(new TextEncoder().encode('again')), { path: 'Again.txt', protection: 0x40, comment: 'c' });
    const id = (r as { id: string }).id;
    expect(await T.retryTransfer(getDb(), { orgId: 'org-a', userId: 'u2', id })).toEqual({ ok: false, reason: 'not_finished' });
    await T.finishTransfer(getDb(), d, id, { ok: false, code: 'space', text: 'full' });
    const again = await T.retryTransfer(getDb(), { orgId: 'org-a', userId: 'u2', id });
    expect(again.ok).toBe(true);
    const n = await row((again as { id: string }).id);
    expect(n).toMatchObject({ path: 'Again.txt', protection: 0x40, comment: 'c', status: 'queued', createdByUserId: 'u2' });
    expect(await T.retryTransfer(getDb(), { orgId: 'org-b', userId: 'u2', id })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('sendSummaries counts per board: waiting, sending, and what finished in the last 24 h', async () => {
    const d = await device('org-s');
    const mk = async (p: string) => (await T.queueTransferFromBlob(getDb(), { orgId: 'org-s', deviceId: d, userId: 'u',
      path: p, sha256: await blob(new TextEncoder().encode(p)) }) as { id: string }).id;
    const a = await mk('a'); const b = await mk('b'); await mk('c'); const old = await mk('old');
    await T.recordChunk(getDb(), d, a, 0);
    await T.finishTransfer(getDb(), d, b, { ok: true, savedAs: 'b' });
    await T.finishTransfer(getDb(), d, old, { ok: false, code: 'crc', text: 'x' }, new Date(Date.now() - 25 * 3600_000));
    expect((await T.sendSummaries(getDb(), 'org-s'))[d]).toEqual({ waiting: 1, sending: 1, delivered: 1, failed: 0 });
  });
```

Create `src/lib/send-targets.db.test.ts` (same own-database pattern as `transfers.db.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_send_targets_test';
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
const { devices } = await import('@/db/schema/devices');
const { games, disks, entitlements } = await import('@/db/schema/catalog');
const S = await import('./send-targets');

const NOW = Date.now();
async function board(id: string, orgId: string, extra: Partial<typeof devices.$inferInsert> = {}) {
  await getDb().insert(devices).values({ id, orgId, name: `Device AA:BB:CC:DD:EE:${id.slice(-2)}`,
    macAddress: `AA:BB:CC:DD:EE:${id.slice(-2)}`, tokenHash: `h-${id}`, ...extra });
}

describe('send targets', () => {
  beforeAll(async () => {
    await admin(`drop database if exists ${DB} with (force)`);
    await admin(`create database ${DB}`);
    await migrate(getDb(), { migrationsFolder: 'drizzle' });
    await board('t-01', 'org-a', { firmwareVersion: '1.15.0+gabc', lastSeenAt: new Date(NOW - 5_000), secondDriveReported: 'net',
      sendRx: 'c', sendRxAt: new Date(NOW - 10_000) });
    await board('t-02', 'org-a', { firmwareVersion: '1.13.0+gdef', lastSeenAt: new Date(NOW) });
    await board('t-03', 'org-a', { firmwareVersion: '1.14.0+g123', lastSeenAt: new Date(NOW) });
    await board('t-04', 'org-b', { firmwareVersion: '1.15.0', lastSeenAt: new Date(NOW) });
    await board('t-05', 'org-a', { name: 'Attic', firmwareVersion: '1.16.0', lastSeenAt: new Date(NOW - 30 * 86_400_000) });
  });
  afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

  it('lists this org\'s boards on 1.15.0 or newer, online first (R1, D11)', async () => {
    const ts = await S.listSendTargets(getDb(), 'org-a', NOW);
    expect(ts.map((t) => t.id)).toEqual(['t-01', 't-05']);
    expect(ts[0]).toMatchObject({ online: true, network: true, rx: 'c', defaultName: true });
    expect(ts[1]).toMatchObject({ name: 'Attic', online: false, network: false, rx: null, defaultName: false });
  });

  it('findSendTarget refuses an old board and another org\'s board', async () => {
    expect(await S.findSendTarget(getDb(), 'org-a', 't-01', NOW)).not.toBeNull();
    expect(await S.findSendTarget(getDb(), 'org-a', 't-02', NOW)).toBeNull();
    expect(await S.findSendTarget(getDb(), 'org-a', 't-04', NOW)).toBeNull();
  });

  it('loadSendDisk reads a disk through this org\'s entitlement only', async () => {
    const sha = 'e'.repeat(64);
    await getDb().insert(games).values({ id: 'g1', orgId: 'org-a', title: 'T', sortTitle: 't', metadataSource: 'filename' });
    await getDb().insert(disks).values({ id: 'k1', gameId: 'g1', orgId: 'org-a', diskNo: 1, sha256: sha, sizeBytes: 901120, label: 'T' });
    await getDb().insert(entitlements).values({ orgId: 'org-a', sha256: sha, sourceFilename: 'T-1.adf' });
    expect(await S.loadSendDisk(getDb(), 'org-a', 'k1')).toMatchObject({ sha256: sha, sourceFilename: 'T-1.adf', diskNo: 1, imageFormat: 'adf' });
    expect(await S.loadSendDisk(getDb(), 'org-b', 'k1')).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm db:dev start` (once; it prints the URL), then
`TEST_DATABASE_URL=<that url> pnpm test:db src/lib/transfers.db.test.ts src/lib/send-targets.db.test.ts`
Expected: FAIL: `T.queueLoad is not a function` (and the others), and `Failed to resolve import "./send-targets"`.

- [ ] **Step 7: Implement in `src/lib/transfers.ts`**

Imports become:

```ts
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { SendSummary } from '@/lib/send-ui';
```

In `queueTransferFromBlob`, the argument type gains `bytes?: Uint8Array`, and the two lines

```ts
  const bytes = await diskStore.read(a.sha256);
  const crc = crc32(bytes) >>> 0;
```

become

```ts
  // The upload route already holds the bytes; reading 4 MB back from the store would only cost time.
  const bytes = a.bytes && a.bytes.byteLength === st.sizeBytes ? a.bytes : await diskStore.read(a.sha256);
  const crc = crc32(bytes) >>> 0;
```

Append:

```ts
export async function queueLoad(db: Db, deviceId: string): Promise<{ files: number; bytes: number }> {
  const [l] = await db.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
    .from(transfers).where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE)));
  return { files: l.n, bytes: Number(l.b) };
}

export type TransferRow = typeof transfers.$inferSelect;

/** The board's rows for the Upload page's queue: this org's only, newest first (finished rows live 7 days). */
export async function listTransfers(db: Db, orgId: string, deviceId: string, limit = 100): Promise<TransferRow[]> {
  return db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), eq(transfers.deviceId, deviceId)))
    .orderBy(desc(transfers.createdAt), desc(transfers.id)).limit(limit);
}

/** Retry (R10): the same file, path, protection and comment, queued again as a new row; the old row stays. */
export async function retryTransfer(db: Db, a: { orgId: string; userId: string; id: string; now?: Date }):
  Promise<QueueResult | { ok: false; reason: 'not_found' | 'not_finished' }> {
  const [r] = await db.select().from(transfers).where(and(eq(transfers.id, a.id), eq(transfers.orgId, a.orgId)));
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.status !== 'failed' && r.status !== 'expired' && r.status !== 'cancelled') return { ok: false, reason: 'not_finished' };
  return queueTransferFromBlob(db, { orgId: a.orgId, deviceId: r.deviceId, userId: a.userId, path: r.path,
    sha256: r.blobSha256, protection: r.protection, comment: r.comment, now: a.now });
}

/** Per board, for the card's line (spec §4; R11): what waits or moves, and what finished in the last 24 h. */
export async function sendSummaries(db: Db, orgId: string, now = new Date()): Promise<Record<string, SendSummary>> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const rows = await db.select({ deviceId: transfers.deviceId, status: transfers.status, n: sql<number>`count(*)::int` })
    .from(transfers)
    .where(and(eq(transfers.orgId, orgId),
      or(and(inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)), gt(transfers.finishedAt, since))))
    .groupBy(transfers.deviceId, transfers.status);
  const out: Record<string, SendSummary> = {};
  for (const r of rows) {
    const s = (out[r.deviceId] ??= { waiting: 0, sending: 0, delivered: 0, failed: 0 });
    if (r.status === 'queued') s.waiting += r.n;
    else if (r.status === 'sending') s.sending += r.n;
    else if (r.status === 'delivered') s.delivered += r.n;
    else if (r.status === 'failed' || r.status === 'expired') s.failed += r.n;
  }
  return out;
}
```

Create `src/lib/send-targets.ts`:

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, entitlements } from '@/db/schema/catalog';
import { firmwareAtLeast } from '@/lib/firmware-version';
import { isOnline } from '@/lib/device-state';
import { isDefaultDeviceName } from '@/lib/device-name';
import { XFER_FW } from '@/lib/send-limits';
import { orderTargets, type Rx, type SendTarget } from '@/lib/send-ui';

const asRx = (v: string | null): Rx | null => (v === 'c' || v === 'r' || v === 'u' || v === '-' ? v : null);

/** The boards a person may send to (spec §4, D11; R1): this org's, on XFER_FW or newer, online first. */
export async function listSendTargets(db: Db, orgId: string, now = Date.now()): Promise<SendTarget[]> {
  const rows = await db.select({
    id: devices.id, name: devices.name, macAddress: devices.macAddress, firmwareVersion: devices.firmwareVersion,
    lastSeenAt: devices.lastSeenAt, secondDriveReported: devices.secondDriveReported,
    sendRx: devices.sendRx, sendRxAt: devices.sendRxAt,
  }).from(devices).where(eq(devices.orgId, orgId)).orderBy(asc(devices.name), asc(devices.id));
  return orderTargets(rows.filter((r) => firmwareAtLeast(r.firmwareVersion, XFER_FW)).map((r) => ({
    id: r.id, name: r.name, macAddress: r.macAddress, defaultName: isDefaultDeviceName(r.name, r.macAddress),
    online: isOnline(r.lastSeenAt, now), lastSeenAt: r.lastSeenAt?.getTime() ?? null,
    network: r.secondDriveReported === 'net', rx: asRx(r.sendRx), rxAt: r.sendRxAt?.getTime() ?? null,
  })));
}

/** One target, or null for a board that is not this org's, does not exist, or cannot take files. */
export async function findSendTarget(db: Db, orgId: string, deviceId: string, now = Date.now()): Promise<SendTarget | null> {
  return (await listSendTargets(db, orgId, now)).find((t) => t.id === deviceId) ?? null;
}

export type SendDisk = { sha256: string; imageFormat: string; tosecName: string | null; sourceFilename: string | null; diskNo: number };

/** A library disk through this org's entitlement, the boundary /api/disks/[id]/adf uses. */
export async function loadSendDisk(db: Db, orgId: string, diskId: string): Promise<SendDisk | null> {
  const [d] = await db.select({ sha256: disks.sha256, imageFormat: disks.imageFormat, tosecName: disks.tosecName,
    sourceFilename: entitlements.sourceFilename, diskNo: disks.diskNo })
    .from(disks)
    .innerJoin(entitlements, and(eq(entitlements.sha256, disks.sha256), eq(entitlements.orgId, orgId)))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  return d ?? null;
}
```

- [ ] **Step 8: Run them to see them pass**

Run: `TEST_DATABASE_URL=<url> pnpm test:db src/lib/transfers.db.test.ts src/lib/send-targets.db.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (transfers 16 tests, send targets 3), tsc 0.

- [ ] **Step 9: Commit**

```bash
git add src/lib/transfers.ts src/lib/transfers.db.test.ts src/lib/send-targets.ts src/lib/send-targets.db.test.ts \
        src/lib/send-from-disk.ts src/lib/send-from-disk.test.ts
git commit -m "send: queue reads for the web (load, list, retry, per-board summary), send targets, files from a disk"
```

---

### Task 4: The user routes

**Files:**
- Create: `src/lib/send-http.ts`
- Create: `src/app/api/transfers/route.ts`, `src/app/api/transfers/[id]/route.ts`,
  `src/app/api/transfers/[id]/retry/route.ts`, `src/app/api/transfers/from-disk/route.ts`
- Test: `src/app/api/transfers/routes.test.ts`

**Interfaces:**
- Consumes: Task 3's `findSendTarget`, `loadSendDisk`, `queueLoad`, `listTransfers`, `retryTransfer`,
  `pickFiles`; increment 2's `queueTransferFromBlob`, `cancelTransfer`, `QueueResult`; Task 2's `adfSendName`,
  `TransferView`, limits.
- Produces (the wire contract Tasks 5-7 use):
  - `GET /api/transfers?deviceId=<id>` → 200 `{ target: SendTarget, transfers: TransferView[], now: number }` | 400 |
    404 `{error:'no_device'}`.
  - `POST /api/transfers?deviceId=<id>&name=<name>`, raw body → 201 `{ ids: [id] }` | 400 `empty`/`bad_name` |
    404 `no_device` | 409 `queue_full` | 413 `too_large`.
  - `DELETE /api/transfers/<id>` → 200 `{ok:true}` | 409 `{error:'not_waiting'}`.
  - `POST /api/transfers/<id>/retry` → 201 `{ ids }` | 404 | 409 `not_finished` | 410 `gone`.
  - `POST /api/transfers/from-disk` JSON `{ deviceId, diskId, blocks?: number[], whole?: true }` → 201 `{ ids }` |
    400 | 404 `no_device`/`not_found`/`no_filesystem` | 409 `queue_full` | 422 `unreadable` | 400 `not_adf` | 503.
  - `export function queueResponse(r: QueueResult): Response; export function toView(r: TransferRow, now: number): TransferView;`

- [ ] **Step 1: Write the failing route tests** `src/app/api/transfers/routes.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { formatVolume } from '@/lib/adffs/format';
import { addFile, makeDirectory, readVolume } from '@/lib/adffs';

vi.mock('@/lib/session', () => ({ requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }) }));
vi.mock('@/db', () => ({ getDb: () => ({}) }));
const store = new Map<string, Uint8Array>();
vi.mock('@/lib/storage', () => ({ diskStore: {
  stat: async (s: string) => (store.has(s) ? { sizeBytes: store.get(s)!.byteLength } : null),
  put: async (s: string, b: Uint8Array) => { store.set(s, b); return { key: `adf/${s}` }; },
  read: async (s: string) => { const b = store.get(s); if (!b) throw new Error('missing'); return b; },
} }));
const findSendTarget = vi.fn();
const loadSendDisk = vi.fn();
vi.mock('@/lib/send-targets', () => ({
  findSendTarget: (...a: unknown[]) => findSendTarget(...a), loadSendDisk: (...a: unknown[]) => loadSendDisk(...a),
}));
const queueTransferFromBlob = vi.fn();
const cancelTransfer = vi.fn();
const retryTransfer = vi.fn();
const queueLoad = vi.fn();
const listTransfers = vi.fn();
vi.mock('@/lib/transfers', () => ({
  queueTransferFromBlob: (...a: unknown[]) => queueTransferFromBlob(...a), cancelTransfer: (...a: unknown[]) => cancelTransfer(...a),
  retryTransfer: (...a: unknown[]) => retryTransfer(...a), queueLoad: (...a: unknown[]) => queueLoad(...a),
  listTransfers: (...a: unknown[]) => listTransfers(...a),
}));

const TARGET = { id: 'dev-1', name: 'Bench', macAddress: null, defaultName: false, online: true, lastSeenAt: 1, network: true, rx: 'c', rxAt: 1 };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
let n = 0;
beforeEach(() => {
  vi.clearAllMocks(); store.clear(); n = 0;
  findSendTarget.mockImplementation(async (_db, _org, id) => (id === 'dev-1' ? TARGET : null));
  queueTransferFromBlob.mockImplementation(async () => ({ ok: true, id: `t${++n}` }));
  queueLoad.mockResolvedValue({ files: 0, bytes: 0 });
});

describe('POST /api/transfers (a file from the computer)', () => {
  const post = (qs: string, body: Uint8Array) =>
    new Request(`http://test/api/transfers${qs}`, { method: 'POST', body: body as unknown as BodyInit });

  it('stores the bytes by sha-256 and queues them for the board, under the session org', async () => {
    const { POST } = await import('./route');
    const res = await POST(post('?deviceId=dev-1&name=Caf%C3%A9.lha', new Uint8Array([1, 2, 3])));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ids: ['t1'] });
    const sha = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
    expect(store.has(sha)).toBe(true);
    expect(queueTransferFromBlob).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ orgId: 'org-1', deviceId: 'dev-1', userId: 'user-1', path: 'Café.lha', sha256: sha }));
  });
  it('refuses a board that cannot take files: another org\'s, or old firmware (Review Focus 1)', async () => {
    const { POST } = await import('./route');
    const res = await POST(post('?deviceId=old-board&name=a', new Uint8Array([1])));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_device' });
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('refuses an empty file, and one over 4 MB, without storing either', async () => {
    const { POST } = await import('./route');
    expect((await POST(post('?deviceId=dev-1&name=a', new Uint8Array(0)))).status).toBe(400);
    const big = await POST(post('?deviceId=dev-1&name=a', new Uint8Array(4_194_305)));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    expect(store.size).toBe(0);
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('passes a full queue and a bad name through as their own answers', async () => {
    const { POST } = await import('./route');
    queueTransferFromBlob.mockResolvedValueOnce({ ok: false, reason: 'queue_full' });
    expect((await POST(post('?deviceId=dev-1&name=a', new Uint8Array([1])))).status).toBe(409);
    queueTransferFromBlob.mockResolvedValueOnce({ ok: false, reason: 'bad_name' });
    expect((await POST(post('?deviceId=dev-1&name=..', new Uint8Array([1])))).status).toBe(400);
  });
});

describe('GET /api/transfers', () => {
  it('returns the board, its rows as views, and the server clock; an expired-in-waiting row reads expired', async () => {
    const { GET } = await import('./route');
    const now = Date.now();
    listTransfers.mockResolvedValue([{ id: 't1', path: 'A', sizeBytes: 5, status: 'queued', bytesSent: 0, savedAs: null,
      errorCode: null, errorText: null, createdAt: new Date(now - 90_000_000), finishedAt: null, expiresAt: new Date(now - 1) }]);
    const res = await GET(new Request('http://test/api/transfers?deviceId=dev-1'));
    const body = await res.json();
    expect(body.target.id).toBe('dev-1');
    expect(body.transfers[0]).toMatchObject({ id: 't1', status: 'expired', createdAt: now - 90_000_000 });
    expect(listTransfers).toHaveBeenCalledWith(expect.anything(), 'org-1', 'dev-1');
  });
  it('404s a board that is not a target', async () => {
    const { GET } = await import('./route');
    expect((await GET(new Request('http://test/api/transfers?deviceId=nope'))).status).toBe(404);
  });
});

describe('DELETE /api/transfers/[id] and retry', () => {
  it('cancels a waiting or moving row; a finished one is 409 "not_waiting" (Review Focus 2)', async () => {
    const { DELETE } = await import('./[id]/route');
    cancelTransfer.mockResolvedValueOnce(true);
    expect((await DELETE(new Request('http://test', { method: 'DELETE' }), ctx('t1'))).status).toBe(200);
    expect(cancelTransfer).toHaveBeenCalledWith(expect.anything(), 'org-1', 't1');
    cancelTransfer.mockResolvedValueOnce(false);
    const late = await DELETE(new Request('http://test', { method: 'DELETE' }), ctx('t1'));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: 'not_waiting' });
  });
  it('retries into a new row, and says why when it cannot', async () => {
    const { POST } = await import('./[id]/retry/route');
    retryTransfer.mockResolvedValueOnce({ ok: true, id: 't9' });
    const ok = await POST(new Request('http://test', { method: 'POST' }), ctx('t1'));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ ids: ['t9'] });
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'not_finished' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(409);
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(404);
    retryTransfer.mockResolvedValueOnce({ ok: false, reason: 'no_blob' });
    expect((await POST(new Request('http://test', { method: 'POST' }), ctx('t1'))).status).toBe(410);
  });
});

describe('POST /api/transfers/from-disk', () => {
  // A real FFS disk: mods/a.txt (protection s, 0x40) and top.txt.
  function disk() {
    let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SendTest' });
    const mk = makeDirectory(adf, 880, 'mods'); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
    const vol = readVolume(adf); if (!vol.ok) throw new Error('no volume');
    const mods = vol.root.find((e) => e.name === 'mods')!.block;
    const a = addFile(adf, mods, 'a.txt', new TextEncoder().encode('hello'), 0x40); if (!a.ok) throw new Error(a.reason); adf = a.adf;
    const b = addFile(adf, 880, 'top.txt', new TextEncoder().encode('top')); if (!b.ok) throw new Error(b.reason); adf = b.adf;
    const sha = createHash('sha256').update(adf).digest('hex');
    store.set(sha, adf);
    loadSendDisk.mockResolvedValue({ sha256: sha, imageFormat: 'adf', tosecName: null, sourceFilename: 'SendTest.dms', diskNo: 1 });
    return { sha, mods };
  }
  const post = (body: unknown) => new Request('http://test/api/transfers/from-disk', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('queues every file of a folder with its relative path, protection and its own blob (R4, R5)', async () => {
    const { mods } = disk();
    const { POST } = await import('./from-disk/route');
    const res = await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: [mods] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ids: ['t1'] });
    const call = queueTransferFromBlob.mock.calls[0][1];
    expect(call).toMatchObject({ path: 'mods/a.txt', protection: 0x40, comment: '' });
    expect(store.get(call.sha256)).toEqual(new TextEncoder().encode('hello'));
  });
  it('sends the whole disk as <name>.adf on the disk\'s own blob', async () => {
    const { sha } = disk();
    const { POST } = await import('./from-disk/route');
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', whole: true }))).status).toBe(201);
    expect(queueTransferFromBlob.mock.calls[0][1]).toMatchObject({ path: 'SendTest.adf', sha256: sha });
  });
  it('refuses the lot when it would overflow the board\'s queue, and queues nothing (Review Focus 3)', async () => {
    disk();
    queueLoad.mockResolvedValue({ files: 31, bytes: 0 });
    const { POST } = await import('./from-disk/route');
    const vol = readVolume(store.values().next().value!); if (!vol.ok) throw new Error('x');
    const res = await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: vol.root.map((e) => e.block) }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'queue_full' });
    expect(queueTransferFromBlob).not.toHaveBeenCalled();
  });
  it('refuses an HFE sent whole, an unknown disk, and a block that is not on the disk', async () => {
    disk();
    const { POST } = await import('./from-disk/route');
    loadSendDisk.mockResolvedValueOnce({ sha256: 'x', imageFormat: 'hfe', tosecName: null, sourceFilename: null, diskNo: 1 });
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', whole: true }))).status).toBe(400);
    loadSendDisk.mockResolvedValueOnce(null);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'nope', whole: true }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1', blocks: [3] }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'old-board', diskId: 'k1', whole: true }))).status).toBe(404);
    expect((await POST(post({ deviceId: 'dev-1', diskId: 'k1' }))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/app/api/transfers/routes.test.ts`
Expected: FAIL, `Failed to resolve import "./route"`.

- [ ] **Step 3: Write `src/lib/send-http.ts`**

```ts
import type { QueueResult, TransferRow } from '@/lib/transfers';
import type { TransferView } from '@/lib/send-ui';

/** One queued file as the user routes answer it: 201 {ids}, or the refusal as its own status and code. */
export function queueResponse(r: QueueResult): Response {
  if (r.ok) return Response.json({ ids: [r.id] }, { status: 201 });
  const status = { bad_name: 400, too_large: 413, queue_full: 409, no_device: 404, no_blob: 410 }[r.reason];
  return Response.json({ error: r.reason === 'no_blob' ? 'gone' : r.reason }, { status });
}

/** A row as the browser sees it. A row still 'queued' past its expiry reads 'expired' at once: the poll already
 *  skips it, and the daily cron only catches up the status. */
export function toView(r: TransferRow, now: number): TransferView {
  const expired = r.status === 'queued' && r.expiresAt.getTime() <= now;
  return {
    id: r.id, path: r.path, sizeBytes: r.sizeBytes, status: expired ? 'expired' : (r.status as TransferView['status']),
    bytesSent: r.bytesSent, savedAs: r.savedAs, errorCode: r.errorCode, errorText: r.errorText,
    createdAt: r.createdAt.getTime(), finishedAt: r.finishedAt?.getTime() ?? null,
  };
}
```

- [ ] **Step 4: Write `src/app/api/transfers/route.ts`**

```ts
// Send to Amiga from the web (PaulaNET Phase 4 increment 3, spec 2026-10-16 §4). GET: the board's queue and its
// receiver state, for the Upload page. POST: one file from the computer, as a raw body (R13), stored by sha-256 in
// the disk store (R2) and queued for the board.
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { listTransfers, queueTransferFromBlob } from '@/lib/transfers';
import { findSendTarget } from '@/lib/send-targets';
import { SEND_FILE_MAX } from '@/lib/send-limits';
import { queueResponse, toView } from '@/lib/send-http';

export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const deviceId = new URL(request.url).searchParams.get('deviceId');
  if (!deviceId) return Response.json({ error: 'invalid_query' }, { status: 400 });
  const db = getDb();
  const now = Date.now();
  const target = await findSendTarget(db, orgId, deviceId, now);
  if (!target) return Response.json({ error: 'no_device' }, { status: 404 });
  const rows = await listTransfers(db, orgId, deviceId);
  return Response.json({ target, transfers: rows.map((r) => toView(r, now)), now }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  const q = new URL(request.url).searchParams;
  const deviceId = q.get('deviceId');
  const name = q.get('name');
  if (!deviceId || !name) return Response.json({ error: 'invalid_query' }, { status: 400 });
  // Refused before a byte is read: a 40 MB drop must not be buffered to learn it is too big.
  if (Number(request.headers.get('content-length') ?? 0) > SEND_FILE_MAX) {
    return Response.json({ error: 'too_large' }, { status: 413 });
  }
  const db = getDb();
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return Response.json({ error: 'empty' }, { status: 400 });
  if (bytes.byteLength > SEND_FILE_MAX) return Response.json({ error: 'too_large' }, { status: 413 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!(await diskStore.stat(sha256))) await diskStore.put(sha256, bytes);
  return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId, userId, path: name, sha256, bytes }));
}
```

- [ ] **Step 5: Write `src/app/api/transfers/[id]/route.ts` and `[id]/retry/route.ts`**

```ts
// Cancel one file (spec §4; R9): waiting or moving. A row already finished is 409, so a cancel that loses the race
// with delivery never turns a delivered file into a cancelled one (Review Focus 2).
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { cancelTransfer } from '@/lib/transfers';

export const maxDuration = 60;

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (await cancelTransfer(getDb(), orgId, id)) return Response.json({ ok: true });
  return Response.json({ error: 'not_waiting' }, { status: 409 });
}
```

```ts
// Retry one failed or expired file (R10): queued again as a new row; the failed row stays as history.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { retryTransfer } from '@/lib/transfers';
import { queueResponse } from '@/lib/send-http';

export const maxDuration = 60;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId, userId } = await requireOrg();
  const { id } = await ctx.params;
  const r = await retryTransfer(getDb(), { orgId, userId, id });
  if (!r.ok && r.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (!r.ok && r.reason === 'not_finished') return Response.json({ error: 'not_finished' }, { status: 409 });
  return queueResponse(r as Exclude<typeof r, { ok: false; reason: 'not_found' | 'not_finished' }>);
}
```

- [ ] **Step 6: Write `src/app/api/transfers/from-disk/route.ts`**

```ts
// Send from a library disk (spec §4 "Shortcuts on the disk pages"): chosen files and folders, each file one row
// with its relative path, protection and comment (R3-R5), or the whole disk as <name>.adf on its own blob. Reads
// the disk's CURRENT bytes, as Download does. All or nothing against the board's limits (Review Focus 3).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { readFile, readVolume } from '@/lib/adffs';
import { queueLoad, queueTransferFromBlob } from '@/lib/transfers';
import { findSendTarget, loadSendDisk } from '@/lib/send-targets';
import { pickFiles } from '@/lib/send-from-disk';
import { SEND_FILE_MAX, SEND_QUEUE_MAX_BYTES, SEND_QUEUE_MAX_FILES } from '@/lib/send-limits';
import { adfSendName } from '@/lib/send-ui';
import { queueResponse } from '@/lib/send-http';

export const maxDuration = 60;

const body = z.object({
  deviceId: z.string().min(1), diskId: z.string().min(1),
  whole: z.literal(true).optional(),
  blocks: z.array(z.number().int().nonnegative()).min(1).max(64).optional(),
}).refine((b) => (b.whole === true) !== (b.blocks !== undefined), { message: 'whole or blocks' });

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const { deviceId, diskId, whole, blocks } = p.data;
  const db = getDb();
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  const disk = await loadSendDisk(db, orgId, diskId);
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  if (whole) {
    if (disk.imageFormat === 'hfe') return Response.json({ error: 'not_adf' }, { status: 400 });
    return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId, userId, path: adfSendName(disk), sha256: disk.sha256 }));
  }

  let adf: Uint8Array;
  try { adf = await diskStore.read(disk.sha256); } catch { return Response.json({ error: 'blob_unavailable' }, { status: 503 }); }
  const vol = readVolume(adf);
  if (!vol.ok) return Response.json({ error: 'no_filesystem' }, { status: 404 });
  const picked = pickFiles(vol.root, blocks!);
  if (picked.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });

  const files: { path: string; protection: number; comment: string; bytes: Uint8Array }[] = [];
  for (const f of picked) {
    const content = readFile(adf, f.block);
    if (!content || !content.complete) return Response.json({ error: 'unreadable', path: f.path }, { status: 422 });
    if (content.bytes.byteLength > SEND_FILE_MAX) return Response.json({ error: 'too_large', path: f.path }, { status: 413 });
    files.push({ path: f.path, protection: f.protection, comment: f.comment, bytes: content.bytes });
  }
  const load = await queueLoad(db, deviceId);
  const total = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  if (load.files + files.length > SEND_QUEUE_MAX_FILES || load.bytes + total > SEND_QUEUE_MAX_BYTES) {
    return Response.json({ error: 'queue_full' }, { status: 409 });
  }
  const ids: string[] = [];
  for (const f of files) {
    const sha256 = createHash('sha256').update(f.bytes).digest('hex');
    if (!(await diskStore.stat(sha256))) await diskStore.put(sha256, f.bytes);
    const r = await queueTransferFromBlob(db, { orgId, deviceId, userId, path: f.path, sha256, protection: f.protection,
      comment: f.comment, bytes: f.bytes });
    // Only a race with another send can refuse here (the load was checked above); what was queued stays queued and
    // is named, and the answer is still a refusal, so the page never says "Queued" for a half-sent folder.
    if (!r.ok) return Response.json({ error: r.reason === 'no_blob' ? 'gone' : r.reason, ids }, { status: 409 });
    ids.push(r.id);
  }
  return Response.json({ ids }, { status: 201 });
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm vitest run src/app/api/transfers/routes.test.ts && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS (12 tests), tsc 0, lint clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/send-http.ts src/app/api/transfers
git commit -m "send: user routes -- upload a file, list and cancel and retry, send from a library disk"
```

---

### Task 5: The help topic

**Files:**
- Modify: `src/lib/help/topics.tsx` (topic `send`, `HELP_ORDER`)
- Modify: `src/lib/help/topics.test.ts` (`IDS`, one claim test)

**Interfaces:**
- Produces: `HelpTopicId` gains `'send'` (Tasks 5-7 draw `<HelpTip topic="send" />`).

- [ ] **Step 1: Write the failing test.** In `topics.test.ts`, add `'send'` to `IDS` after `'network'`, and add to
  the second `describe`:

```ts
  it('send names the limits, Receive, the expiry and the accepted risk', () => {
    const s = HELP_TOPICS.send.short + bodyText('send');
    expect(s).toMatch(/Receive/);
    expect(s).toMatch(/4 MB/);
    expect(s).toMatch(/24 hours/);
    expect(s).toMatch(/1\.15\.0/);
    expect(s).toMatch(/any computer on your network/);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/help/topics.test.ts`
Expected: FAIL, `has exactly the spec topics` (missing `send`) and `Cannot read properties of undefined`.

- [ ] **Step 3: Write the topic.** In `topics.tsx`, after the `network` topic:

```tsx
  // Sources: spec docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md §1 (D4 limits, D8 never
  // overwrite, D9 accepted risk), §4 (the Upload page column, Browse Send, Send .adf), §5 (Receive, Install);
  // src/lib/send-limits.ts (XFER_FW, limits), src/lib/send-ui.ts (the words), tools/paulanet-disk/Install;
  // plan 2026-10-17 rulings R1 (1.15.0), R9 (Cancel while sending), R10 (Retry).
  send: {
    title: 'Sending files to the Amiga',
    short:
      'Send files from your computer, or from a disk in your library, to a folder on your Amiga. The Amiga saves them with Receive, from the PaulaNET driver disk.',
    body: (
      <>
        <p>
          Your board must be in <em>Network (PaulaNET)</em> mode, on firmware 1.15.0 or newer. On the Amiga, run{' '}
          <em>Install</em> from the driver disk once: it copies <em>Receive</em> to SYS:Tools and C:. Start Receive by
          hand, choose a folder and press Save. The default folder is RAM:.
        </p>
        <p>
          <strong>Three ways to send.</strong> On the Upload page, drop any file under <em>Send to Amiga</em>. On a
          disk&apos;s Browse page, press <em>Send</em> on a file or a folder. On a title&apos;s page, press{' '}
          <em>Send .adf to Amiga</em> to send a whole disk as one file. The Upload page shows each file waiting, on its
          way, delivered with the name it was saved as, or failed with the reason.
        </p>
        <GoodToKnow items={[
          'Up to 4 MB a file, and up to 32 files or 16 MB waiting for one board.',
          'A file sent while Receive is closed waits up to 24 hours, then expires.',
          'Nothing is overwritten: a second Foo.lha arrives as Foo_2.lha.',
          'Cancel stops a file that is waiting or on its way. Retry sends a failed one again from the start.',
          'While Receive runs, any computer on your network can drop a file into its folder. It cannot overwrite anything or leave the folder, and nothing is run.',
        ]} />
      </>
    ),
  },
```

and in `HELP_ORDER`, insert `'send'` after `'network'`.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run src/lib/help/topics.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (the `send` short is 2 sentences, the body 60-260 words, no banned words), tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/help/topics.tsx src/lib/help/topics.test.ts
git commit -m "help: Sending files to the Amiga"
```

---

### Task 6: The Upload page's Send to Amiga column

**Files:**
- Create: `src/components/send/use-send-board.ts`, `src/components/send/send-panel.tsx`
- Modify: `src/app/(app)/ingest/page.tsx`, `src/components/ingest/dropzone.tsx:457` (root class)
- Create: `e2e/send-to-amiga.spec.ts`; Modify: `e2e/mobile.spec.ts` (one test)

**Interfaces:**
- Consumes: Task 1 (`pairDevice(page, request, 'Bench')` keeps the name); Task 2 (`pickTarget`, `orderTargets`, `longOffline`, `targetState`, `receiverLine`, `transferState`,
  `canCancel`, `canRetry`, `sendErrorText`, `formatSize`, `SEND_BOARD_KEY`), Task 3 `listSendTargets`, Task 4 routes,
  Task 5 topic.
- Produces: `export function useSendBoard(targets: SendTarget[], now: number, initial?: string | null): [string | null, (id: string) => void]`;
  `export function SendPanel(props: { targets: SendTarget[]; initialBoard: string | null; serverNow: number })`.
  Test ids: `send-dropzone`, `send-file-input`, `send-board`, `send-board-picker`, `send-board-<id>`,
  `send-show-offline`, `send-receiver`, `send-queue`, `send-row-<id>` (`data-status`), `send-state-<id>`,
  `send-cancel-<id>`, `send-retry-<id>`, `send-upload` (`data-state`), `send-no-board`. `/ingest?board=<id>`
  preselects a board.

- [ ] **Step 1: Write the failing e2e** `e2e/send-to-amiga.spec.ts`

```ts
// PaulaNET Phase 4 increment 3 (spec 2026-10-16 §4, §7 e2e): the web side of sending to the Amiga. The board is
// simulated through its own routes (status, poll, queue, chunk, done), as e2e/device-send.spec.ts does.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(async () => { await cleanupSeeded(); });
const LIVE = 15_000;

/** The board reports Network mode on 1.15.0 and its receiver state (since=999999 answers at once). */
async function boardSays(request: APIRequestContext, token: string, rx: 'c' | 'r' | 'u' | '-', firmware = '1.15.0+gabc1234') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0 } })).status()).toBe(204);
  expect((await request.get(`/api/device/poll?since=999999&xferAck=0&rx=${rx}`, { headers: authHeader(token) })).status()).toBe(200);
}

/** The board takes the queue's NEXT file whole and posts the outcome. */
async function boardTakesNext(request: APIRequestContext, token: string,
  outcome: { ok: true; savedAs: string } | { ok: false; code: string; text: string }) {
  const text = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  const m = /^NEXT (\S+) (\d+) /.exec(text);
  expect(m, text).not.toBeNull();
  const [, id, size] = m!;
  for (let off = 0; off < Number(size); off += 16_384) {
    expect((await request.get(`/api/device/send/${id}?offset=${off}&length=16384`, { headers: authHeader(token) })).status()).toBe(200);
  }
  expect((await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: outcome })).status()).toBe(204);
  return id;
}

async function dropFile(page: Page, name: string, buffer: Buffer) {
  await page.getByTestId('send-file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a file dropped under Send to Amiga waits, the board takes it, and it reads delivered with its saved name', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  await page.goto('/ingest');
  await expect(page.getByRole('heading', { name: 'Add to library' })).toBeVisible();
  await expect(page.getByTestId('dropzone')).toBeVisible();          // the library upload is unchanged
  await expect(page.getByTestId('send-board')).toContainText('Bench');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Receive is not running on the Amiga');

  await dropFile(page, 'Café.txt', Buffer.from('hello amiga'));
  const row = page.locator('[data-testid^="send-row-"]').first();
  await expect(row).toHaveAttribute('data-status', 'queued', { timeout: LIVE });
  await expect(row).toContainText('Café.txt');
  await expect(row).toContainText('Waiting');
  await expect(page.getByTestId('send-receiver')).toHaveText('• Start Receive on the Amiga', { timeout: LIVE });

  await boardSays(request, token, 'c');
  await expect(page.getByTestId('send-receiver')).toHaveText('✓ Receive is running on the Amiga', { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: true, savedAs: 'Café_2.txt' });
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Delivered · saved as Café_2.txt', { timeout: LIVE });
  await expect(page.getByTestId(`send-cancel-${id}`)).toHaveCount(0);
});

test('Cancel takes a waiting file out of the board\'s queue; a cancel after delivery says it already finished', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'One.bin', Buffer.alloc(100, 1));
  const row = page.locator('[data-testid^="send-row-"]').first();
  await expect(row).toHaveAttribute('data-status', 'queued', { timeout: LIVE });
  const id = (await row.getAttribute('data-testid'))!.replace('send-row-', '');
  await page.getByTestId(`send-cancel-${id}`).click();
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Cancelled', { timeout: LIVE });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toBe('NEXT -\nLIST 0\n');

  // Review Focus 2: a cancel that arrives after the board delivered is refused, and the row stays Delivered. (Sent by
  // request, not by the button: the page refreshes every 3 s, so whether the button is still there is a race.)
  await dropFile(page, 'Two.bin', Buffer.alloc(100, 2));
  const two = page.locator('[data-testid^="send-row-"][data-status="queued"]').first();
  await expect(two).toBeVisible({ timeout: LIVE });
  const twoId = (await two.getAttribute('data-testid'))!.replace('send-row-', '');
  await boardTakesNext(request, token, { ok: true, savedAs: 'Two.bin' });
  const late = await page.request.delete(`/api/transfers/${twoId}`);
  expect(late.status()).toBe(409);
  expect(await late.json()).toEqual({ error: 'not_waiting' });
  await expect(page.getByTestId(`send-state-${twoId}`)).toHaveText('Delivered · saved as Two.bin', { timeout: LIVE });
});

test('a failure shows Receive\'s reason, and Retry queues the file again', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Full.bin', Buffer.alloc(300, 3));
  await expect(page.locator('[data-testid^="send-row-"][data-status="queued"]')).toHaveCount(1, { timeout: LIVE });
  const id = await boardTakesNext(request, token, { ok: false, code: 'space', text: 'disk full' });
  await expect(page.getByTestId(`send-state-${id}`)).toHaveText('Failed · not enough space on the Amiga', { timeout: LIVE });
  await page.getByTestId(`send-retry-${id}`).click();
  await expect(page.locator('[data-testid^="send-row-"][data-status="queued"]')).toHaveCount(1, { timeout: LIVE });
});

test('a file over 4 MB is refused in the browser, and a board below 1.15.0 is never offered', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  await page.goto('/ingest');
  await dropFile(page, 'Big.bin', Buffer.alloc(4_194_305));
  await expect(page.getByTestId('send-upload')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('send-upload')).toContainText('Over 4 MB: too large to send.');

  await boardSays(request, token, 'c', '1.13.0+gdef5678');
  await page.goto('/ingest');
  await expect(page.getByTestId('send-no-board')).toContainText('1.15.0');
});
```

In `e2e/mobile.spec.ts`, add (with `import { pairDevice, authHeader } from './device-helpers';` if not imported):

```ts
test('the Upload page stacks its two columns at 390px, and a 200-byte saved path wraps', async ({ page, request }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'A board with a rather long name for a phone screen');
  await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.15.0+gabc1234', secondDrive: 'net', driveVersion: 0 } });
  await request.get('/api/device/poll?since=999999&xferAck=0&rx=c', { headers: authHeader(token) });
  await page.goto('/ingest');
  await page.getByTestId('send-file-input').setInputFiles({ name: 'p.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await expect(page.locator('[data-testid^="send-row-"]')).toHaveCount(1, { timeout: 15_000 });
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  const id = /^NEXT (\S+) /.exec(q)![1];
  await request.get(`/api/device/send/${id}?offset=0&length=1`, { headers: authHeader(token) });
  const long = Array.from({ length: 7 }, (_, i) => `Folder${i}${'x'.repeat(21)}`).join('/') + '/p.txt';
  expect(long.length).toBeGreaterThanOrEqual(200);
  await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: { ok: true, savedAs: long } });
  await expect(page.getByTestId(`send-state-${id}`)).toContainText('Delivered', { timeout: 15_000 });
  const add = await page.getByTestId('dropzone').boundingBox();
  const send = await page.getByTestId('send-dropzone').boundingBox();
  expect(send!.y).toBeGreaterThan(add!.y + add!.height);              // stacked, not side by side
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts --project=desktop > /tmp/e2e-send.log 2>&1; tail -15 /tmp/e2e-send.log`
Expected: 4 failed (`getByRole('heading', { name: 'Add to library' })` not found / `send-file-input` not found).

- [ ] **Step 3: Write `src/components/send/use-send-board.ts`**

```ts
'use client';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { pickTarget, SEND_BOARD_KEY, type SendTarget } from '@/lib/send-ui';

// The board files are sent to (spec §4: "the last choice remembered in the browser"). One choice for every Send
// control on every page, kept in localStorage and announced in-page, so the disk pages' picker and their Send
// buttons agree. Browser storage can throw (private windows); it then falls back to the first target.
const EVENT = 'webadf:send-board';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(EVENT, onChange); };
}
function readStored(): string | null {
  try { return window.localStorage.getItem(SEND_BOARD_KEY); } catch { return null; }
}

export function useSendBoard(targets: SendTarget[], now: number, initial: string | null = null): [string | null, (id: string) => void] {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const [chosen, setChosen] = useState<string | null>(initial);
  const id = pickTarget(targets, chosen ?? stored, now);
  const set = useCallback((v: string) => {
    setChosen(v);
    try { window.localStorage.setItem(SEND_BOARD_KEY, v); } catch { /* not remembered; this page still uses it */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [id, set];
}
```

- [ ] **Step 4: Write `src/components/send/send-panel.tsx`**

```tsx
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { SEND_FILE_MAX, XFER_FW } from '@/lib/send-limits';
import {
  canCancel, canRetry, formatSize, longOffline, orderTargets, receiverLine, sendErrorText, targetState, transferState,
  type SendTarget, type TransferView,
} from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';

type Upload = { key: string; name: string; state: 'uploading' | 'failed'; note?: string };
type Snapshot = { target: SendTarget; transfers: TransferView[]; now: number };
const TONE = { ok: 'var(--success-fg)', busy: 'var(--amber-text)', bad: 'var(--danger-fg)', muted: 'var(--muted)' } as const;
// While anything waits or moves the queue is read every 3 s (progress is per 16 KB chunk); otherwise every 10 s.
const ACTIVE_MS = 3_000;
const IDLE_MS = 10_000;
const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';

/**
 * The Upload page's right column (spec §4): which board, whether Receive runs there, a drop zone for any file, and
 * every transfer for that board however it was sent. Reads its own queue route rather than the page's live
 * fingerprint, because progress moves on every chunk and the fingerprint moves on state changes only.
 */
export function SendPanel({ targets, initialBoard, serverNow }: { targets: SendTarget[]; initialBoard: string | null; serverNow: number }) {
  const [board, setBoard] = useSendBoard(targets, serverNow, initialBoard);
  const [showOffline, setShowOffline] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const seq = useRef(0);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    if (!board) return;
    try {
      const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(board)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      setSnap((await res.json()) as Snapshot);
    } catch { /* offline, signed out or a deploy: the next tick tries again */ }
  }, [board]);

  useEffect(() => {
    active.current = snap?.transfers.some((t) => canCancel(t.status)) ?? false;
  }, [snap]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped) timer = setTimeout(tick, active.current ? ACTIVE_MS : IDLE_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [refresh]);

  if (targets.length === 0) {
    return (
      <div className="glass-card mx-4 p-5 text-[13px] sm:mx-7 lg:ml-3.5" style={{ color: 'var(--muted)' }} data-testid="send-no-board">
        No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
        <Link href="/devices" className="font-semibold underline underline-offset-2">Devices</Link>
      </div>
    );
  }

  const view = snap && snap.target.id === board ? snap : null;
  const now = view?.now ?? serverNow;
  const ordered = orderTargets(targets);
  const shown = ordered.filter((t) => showOffline || !longOffline(t, now) || t.id === board);
  const hidden = ordered.length - shown.length;
  const current = view?.target ?? targets.find((t) => t.id === board) ?? null;
  const waiting = view?.transfers.filter((t) => t.status === 'queued').length ?? 0;
  const sending = view?.transfers.some((t) => t.status === 'sending') ?? false;
  const line = current ? receiverLine(current, { waiting, sending }, now) : null;

  async function handleFiles(list: FileList) {
    const to = board;
    if (!to) return;
    for (const file of Array.from(list)) {
      const key = `u${++seq.current}`;
      if (file.size === 0 || file.size > SEND_FILE_MAX) {
        setUploads((u) => [...u, { key, name: file.name, state: 'failed', note: sendErrorText(file.size === 0 ? 'empty' : 'too_large', 0) }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: file.name, state: 'uploading' }]);
      try {
        const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(to)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        if (res.ok) { setUploads((u) => u.filter((x) => x.key !== key)); await refresh(); continue; }
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'failed', note: sendErrorText(b?.error, res.status) } : x)));
      } catch {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'failed', note: 'The upload did not finish. Check the connection and try again.' } : x)));
      }
    }
  }

  async function cancel(id: string) {
    const res = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (!res) toast.error('Could not cancel', { description: 'Check the connection and try again.' });
    else if (res.status === 409) toast.info('Already finished', { description: 'It ended before the cancel arrived.' });
    else if (!res.ok) toast.error('Could not cancel', { description: `The server answered ${res.status}.` });
    await refresh();
  }

  async function retry(id: string) {
    const res = await fetch(`/api/transfers/${encodeURIComponent(id)}/retry`, { method: 'POST' }).catch(() => null);
    if (!res) toast.error('Could not retry', { description: 'Check the connection and try again.' });
    else if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error('Could not retry', { description: sendErrorText(b?.error, res.status) });
    }
    await refresh();
  }

  return (
    <div className="mx-4 flex min-w-0 flex-col gap-3 sm:mx-7 lg:ml-3.5">
      {targets.length === 1 ? (
        <p className="text-[12.5px]" style={{ color: 'var(--ink)' }} data-testid="send-board">
          To <strong>{targets[0].name}</strong> · {targetState(targets[0], now)}
        </p>
      ) : (
        <fieldset className="glass-card flex flex-col gap-1 p-3" data-testid="send-board-picker">
          <legend className="sr-only">Board to send to</legend>
          {shown.map((t) => (
            <label key={t.id} className="flex min-w-0 items-center gap-2 text-[12.5px]" data-testid={`send-board-${t.id}`}>
              <input type="radio" name="send-board" checked={t.id === board} onChange={() => setBoard(t.id)} />
              <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.name}</span>
              <span className="shrink-0 text-[11px]" style={{ color: t.online ? 'var(--success-fg)' : 'var(--muted)' }}>{targetState(t, now)}</span>
              {t.defaultName && (
                <Link href={`/devices#device-${t.id}`} className="shrink-0 text-[11px] underline" style={{ color: 'var(--muted)' }}>Name it</Link>
              )}
            </label>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowOffline(true)} className="self-start text-[11px] underline"
                    style={{ color: 'var(--muted)' }} data-testid="send-show-offline">
              Show offline ({hidden})
            </button>
          )}
        </fieldset>
      )}

      {line && (
        <p role="status" className="text-[12.5px] font-semibold" data-testid="send-receiver" data-ok={String(line.ok)}
           style={{ color: line.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
          {line.ok ? '✓ ' : '• '}{line.text}
        </p>
      )}

      <label data-testid="send-dropzone"
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
             className="glass-card flex h-32 cursor-pointer flex-col items-center justify-center gap-1 px-4 text-center"
             style={{ borderStyle: 'dashed', borderColor: 'rgb(245 130 46 / 0.55)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Drop any file here, or choose one</span>
        <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>Up to 4 MB each. It waits here until the Amiga takes it.</span>
        <input type="file" multiple className="sr-only" data-testid="send-file-input"
               onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); e.target.value = ''; }} />
      </label>

      <ul aria-label="Files for this board" className="glass-card flex flex-col overflow-hidden" data-testid="send-queue">
        {uploads.map((u) => (
          <li key={u.key} data-testid="send-upload" data-state={u.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2"
              style={{ borderColor: 'var(--hairline)' }}>
            <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{u.name}</span>
            <span className="basis-full text-[12px]" style={{ color: u.state === 'failed' ? TONE.bad : TONE.busy }}>
              {u.state === 'uploading' ? 'Uploading…' : `Not sent · ${u.note}`}
            </span>
            {u.state === 'failed' && (
              <button type="button" className={btn} style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
                      onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Dismiss</button>
            )}
          </li>
        ))}
        {view?.transfers.map((t) => {
          const s = transferState(t);
          return (
            <li key={t.id} data-testid={`send-row-${t.id}`} data-status={t.status}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2" style={{ borderColor: 'var(--hairline)' }}>
              <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.path}</span>
              <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>{formatSize(t.sizeBytes)}</span>
              <span className="basis-full text-[12px]" data-testid={`send-state-${t.id}`}
                    style={{ color: TONE[s.tone], overflowWrap: 'anywhere' }}>{s.text}</span>
              {canCancel(t.status) && (
                <button type="button" aria-label={`Cancel ${t.path}`} data-testid={`send-cancel-${t.id}`} onClick={() => void cancel(t.id)}
                        className={btn} style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>Cancel</button>
              )}
              {canRetry(t.status) && (
                <button type="button" aria-label={`Retry ${t.path}`} data-testid={`send-retry-${t.id}`} onClick={() => void retry(t.id)}
                        className={`${btn} text-white`} style={{ background: 'var(--primary-action)' }}>Retry</button>
              )}
            </li>
          );
        })}
        {view === null && uploads.length === 0 && (
          <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Reading the queue…</li>
        )}
        {view !== null && view.transfers.length === 0 && uploads.length === 0 && (
          <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="send-queue-empty">
            Nothing sent to this board in the last 7 days.
          </li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Split the page.** In `src/components/ingest/dropzone.tsx` line 457, the root
  `className="mx-4 flex flex-col gap-4 sm:mx-7"` becomes `className="mx-4 flex flex-col gap-4 sm:mx-7 lg:mr-3.5"`.
  Replace `src/app/(app)/ingest/page.tsx` with:

```tsx
import { requireOrg } from '@/lib/session';
import { getDb } from '@/db';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';
import { SendPanel } from '@/components/send/send-panel';
import { HelpTip } from '@/components/help/help-tip';
import { listSendTargets } from '@/lib/send-targets';

export default async function IngestPage(props: PageProps<'/ingest'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  // ?board= comes from the card's line and the disk pages' "See queue"; an id that is not a target is ignored.
  const board = typeof sp.board === 'string' ? sp.board : null;
  const now = Date.now();
  const targets = await listSendTargets(getDb(), orgId, now);
  const h2 = 'text-[12px] font-bold uppercase tracking-wide';
  return (
    <>
      {/* The nav label and this heading both say "Upload"; the ROUTE stays
          /ingest. The route, the /api/ingest/* namespace, src/proxy.ts's
          matcher and the CLI all key on that word (HANDOFF backlog). */}
      <PageHeader eyebrow="Add disks" title="Upload" subtitle="hash first, upload only what is missing" />
      {/* Two columns from lg (operator, 2026-10-16), stacked below: the library upload unchanged on the left. */}
      <div className="grid items-start gap-y-6 pb-10 lg:grid-cols-2">
        <section aria-labelledby="add-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="add-heading" className={`mx-4 sm:mx-7 lg:mr-3.5 ${h2}`} style={{ color: 'var(--muted)' }}>Add to library</h2>
          <Dropzone />
        </section>
        <section aria-labelledby="send-heading" className="flex min-w-0 flex-col gap-3">
          <h2 id="send-heading" className={`mx-4 flex items-center gap-1 sm:mx-7 lg:ml-3.5 ${h2}`} style={{ color: 'var(--muted)' }}>
            Send to Amiga <HelpTip topic="send" />
          </h2>
          <SendPanel targets={targets} initialBoard={board} serverNow={now} />
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Run the e2e to see it pass, plus the page's old specs**

Run: `pnpm exec tsc --noEmit && pnpm lint && PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts e2e/ingest-ui.spec.ts --project=desktop > /tmp/e2e-send.log 2>&1; tail -15 /tmp/e2e-send.log`
Expected: tsc 0, lint clean, `N passed` with 0 failed (4 send + the ingest-ui tests).
Then, after the teardown line: `PORT=3100 pnpm exec playwright test e2e/mobile.spec.ts --project=mobile -g "Upload page stacks" > /tmp/e2e-m.log 2>&1; tail -5 /tmp/e2e-m.log`
Expected: `1 passed`.

- [ ] **Step 7: Commit**

```bash
git add src/components/send/use-send-board.ts src/components/send/send-panel.tsx "src/app/(app)/ingest/page.tsx" \
        src/components/ingest/dropzone.tsx e2e/send-to-amiga.spec.ts e2e/mobile.spec.ts
git commit -m "upload page: Send to Amiga column -- board, receiver state, drop zone, the board's queue with cancel and retry"
```

---

### Task 7: The disk pages' shortcuts

**Files:**
- Create: `src/components/send/send-button.tsx`
- Modify: `src/components/disks/file-tree.tsx` (FileTree prop, FileRow Send button)
- Modify: `src/app/(app)/disks/[id]/files/page.tsx` (targets, picker, prop)
- Modify: `src/components/games/disk-row.tsx`, `src/components/games/disk-set-section.tsx`,
  `src/app/(app)/games/[id]/page.tsx`
- Modify: `e2e/send-to-amiga.spec.ts` (two tests)

**Interfaces:**
- Consumes: Task 6 `useSendBoard`; Task 2 `SendContext`, `orderTargets`, `targetState`, `sendErrorText`; Task 4
  `POST /api/transfers/from-disk`; Task 3 `listSendTargets`.
- Produces: `export function useSendAction(ctx: SendContext | null): { send(body: { diskId: string; blocks?: number[]; whole?: true }, what: string): Promise<void>; busy: boolean } | null;`
  `export function SendBoardPicker({ ctx }: { ctx: SendContext | null })`;
  `export function SendAdfButton({ ctx, diskId }: { ctx: SendContext; diskId: string })`.
  Test ids: `fs-send-<block>`, `send-adf-<diskId>`, `send-board-select`.

- [ ] **Step 1: Write the failing e2e.** Append to `e2e/send-to-amiga.spec.ts` (add these imports at the top:
  `import { createHash } from 'node:crypto'; import { diskStore } from '@/lib/storage'; import { formatVolume } from '@/lib/adffs/format'; import { addFile, makeDirectory, readVolume } from '@/lib/adffs'; import { seedDisk } from './device-helpers'; import { runTag } from './helpers';`):

```ts
async function seedSendDisk(orgId: string, title: string) {
  let adf = formatVolume({ filesystem: 'FFS', volumeName: 'SendTest' });
  const mk = makeDirectory(adf, 880, 'mods'); if (!mk.ok) throw new Error(mk.reason); adf = mk.adf;
  const v = readVolume(adf); if (!v.ok) throw new Error('no volume');
  const mods = v.root.find((e) => e.name === 'mods')!.block;
  const a = addFile(adf, mods, 'a.txt', new TextEncoder().encode('hello'), 0x40); if (!a.ok) throw new Error(a.reason); adf = a.adf;
  const sha = createHash('sha256').update(adf).digest('hex');
  if (!(await diskStore.stat(sha))) await diskStore.put(sha, adf);
  return { ...(await seedDisk(orgId, { title, diskNo: 1, sha256: sha })), mods };
}

test('Browse: Send on a folder queues its files with their paths and protection', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  const { diskId, mods } = await seedSendDisk(orgId, `S${runTag().slice(0, 6)}`);
  await page.goto(`/disks/${diskId}/files`);
  await page.getByTestId(`fs-send-${mods}`).click();
  await expect(page.getByText('Queued for Bench')).toBeVisible();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toMatch(/^NEXT \S+ 5 [0-9a-f]+ 40 10:mods\/a\.txt 0:\n/);
  await page.getByRole('button', { name: 'See queue' }).click();
  await expect(page).toHaveURL(/\/ingest\?board=/);
  await expect(page.locator('[data-testid^="send-row-"][data-status="queued"]')).toContainText('mods/a.txt');
});

test('a title page: Send .adf to Amiga queues the whole disk as <name>.adf', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'c');
  const title = `S${runTag().slice(0, 6)}`;
  const { gameId, diskId } = await seedSendDisk(orgId, title);
  await page.goto(`/games/${gameId}`);
  await page.getByTestId(`send-adf-${diskId}`).click();
  await expect(page.getByText('Queued for Bench')).toBeVisible();
  const q = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(q).toContain(` 901120 ${`${title}-1.adf`.length}:${title}-1.adf\n`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts --project=desktop -g "Browse|title page" > /tmp/e2e-send.log 2>&1; tail -10 /tmp/e2e-send.log`
Expected: 2 failed (`fs-send-…` / `send-adf-…` not found).

- [ ] **Step 3: Write `src/components/send/send-button.tsx`**

```tsx
'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { orderTargets, sendErrorText, targetState, type SendContext } from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';

type FromDisk = { diskId: string; blocks?: number[]; whole?: true };

/**
 * Send from a disk page to the board chosen on the Upload page (spec §4 "Shortcuts on the disk pages"), confirmed
 * "Queued for <board> · See queue". Null when this org has no board that can take files: no button is drawn.
 */
export function useSendAction(ctx: SendContext | null) {
  const router = useRouter();
  const [board] = useSendBoard(ctx?.targets ?? [], ctx?.now ?? 0);
  const [busy, setBusy] = useState(false);
  const send = useCallback(async (body: FromDisk, what: string) => {
    if (!ctx || !board) return;
    const name = ctx.targets.find((t) => t.id === board)?.name ?? 'the board';
    setBusy(true);
    try {
      const res = await fetch('/api/transfers/from-disk', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: board, ...body }),
      });
      const json = (await res.json().catch(() => null)) as { ids?: string[]; error?: string } | null;
      if (!res.ok) { toast.error(`Could not send ${what}`, { description: sendErrorText(json?.error, res.status) }); return; }
      const n = json?.ids?.length ?? 1;
      toast.success(`Queued for ${name}`, {
        description: n > 1 ? `${what} (${n} files)` : what,
        action: { label: 'See queue', onClick: () => router.push(`/ingest?board=${encodeURIComponent(board)}`) },
      });
    } catch {
      toast.error(`Could not send ${what}`, { description: 'Check the connection and try again.' });
    } finally {
      setBusy(false);
    }
  }, [ctx, board, router]);
  return ctx && ctx.targets.length > 0 && board ? { send, busy } : null;
}

/** "a small menu changes it" (spec §4): drawn only with two or more boards to choose from. */
export function SendBoardPicker({ ctx }: { ctx: SendContext | null }) {
  const [board, setBoard] = useSendBoard(ctx?.targets ?? [], ctx?.now ?? 0);
  if (!ctx || ctx.targets.length < 2) return null;
  return (
    <label className="flex min-w-0 items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
      Send to
      <select value={board ?? ''} onChange={(e) => setBoard(e.target.value)} data-testid="send-board-select"
              className="min-w-0 max-w-[60vw] rounded border bg-transparent px-2 py-1 text-[12px]"
              style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
        {orderTargets(ctx.targets).map((t) => (
          <option key={t.id} value={t.id}>{t.name} · {targetState(t, ctx.now)}</option>
        ))}
      </select>
    </label>
  );
}

/** The disk row's "Send .adf to Amiga" (spec §4): the disk's own blob, named <disk name>.adf by the server. */
export function SendAdfButton({ ctx, diskId }: { ctx: SendContext; diskId: string }) {
  const s = useSendAction(ctx);
  if (!s) return null;
  return (
    <button type="button" disabled={s.busy} onClick={() => void s.send({ diskId, whole: true }, 'the whole disk')}
            data-testid={`send-adf-${diskId}`}
            className="btn-like shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>
      Send .adf to Amiga
    </button>
  );
}
```

- [ ] **Step 4: Wire the file tree.** In `src/components/disks/file-tree.tsx`:
  - imports: `import type { SendContext } from '@/lib/send-ui';` and `import { useSendAction } from '@/components/send/send-button';`
  - the signature becomes
    `export function FileTree({ entries, diskId, send = null }: { entries: AdfEntry[]; diskId: string; send?: SendContext | null }) {`
    and right after `const { disabled, busy, runEdit, rootBlock } = useFileEdit();` add
    `const sender = useSendAction(send);`
  - in the `<FileRow … />` props add:

```tsx
            canSend={sender !== null}
            sendBusy={sender?.busy ?? false}
            onSend={(e) => void sender?.send({ diskId, blocks: [e.block] }, e.kind === 'dir' ? `${e.name}/` : e.name)}
```

  - in `interface FileRowProps` add:

```ts
  /** A board can take files (useSendAction): draw Send on this row (spec §4; R3). */
  canSend: boolean;
  sendBusy: boolean;
  onSend: (entry: AdfEntry) => void;
```

  - add `canSend, sendBusy, onSend,` to `FileRow`'s destructured props, and inside the `sm:contents` wrapper, right
    after the Download link / spacer (the `)}` that closes `{!isDir ? (...) : (<span className="hidden w-[68px] …" />)}`):

```tsx
        {/* Send to the Amiga (spec §4, R3): a file, or a folder with everything in it. Withdrawn while browsing an
            older version for the same reason as Download: the route reads the CURRENT head. */}
        {canSend && (
          <button type="button" onClick={() => onSend(entry)}
                  disabled={sendBusy || editDisabled?.reason === 'historical'}
                  title={editDisabled?.reason === 'historical' ? editDisabled.message : undefined}
                  aria-label={`Send ${entry.name} to the Amiga`}
                  data-testid={`fs-send-${entry.block}`}
                  className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>
            Send
          </button>
        )}
```

- [ ] **Step 5: Wire the pages.**
  - `src/app/(app)/disks/[id]/files/page.tsx`: imports
    `import { listSendTargets } from '@/lib/send-targets';` and `import { SendBoardPicker } from '@/components/send/send-button';`.
    After `const held = holderText(choices);` add:

```ts
  // Send to Amiga from this disk (spec §4): the boards that can take files; none = no Send buttons at all.
  const sendTargets = await listSendTargets(getDb(), orgId);
  const send = sendTargets.length > 0 ? { targets: sendTargets, now: Date.now() } : null;
```

    In the mount bar, replace `<MountAction diskId={id} choices={choices} />` with

```tsx
          <div className="flex flex-wrap items-center gap-3">
            <SendBoardPicker ctx={send} />
            <MountAction diskId={id} choices={choices} />
          </div>
```

    and `<FileTree entries={volume.root} diskId={id} />` becomes `<FileTree entries={volume.root} diskId={id} send={send} />`.
  - `src/components/games/disk-row.tsx`: imports `import type { SendContext } from '@/lib/send-ui';` and
    `import { SendAdfButton } from '@/components/send/send-button';`; the props gain
    `send?: SendContext | null;` (destructure `send = null`) with the doc comment
    `/** Boards that can take files; null = no Send button (spec §4 "the disk row"). */`; after
    `<MountAction diskId={disk.id} choices={choices} />` add
    `{send && !isHfe && <SendAdfButton ctx={send} diskId={disk.id} />}`.
  - `src/components/games/disk-set-section.tsx`: the props gain `send?: SendContext | null` (destructure `send = null`,
    import the type), and its `<DiskRow …>` gets `send={send}`.
  - `src/app/(app)/games/[id]/page.tsx`: import `getDb`, `listSendTargets`, `SendBoardPicker`; add
    `listSendTargets(getDb(), orgId)` as a fifth entry of the `Promise.all` (`sendTargets`), then after `const now = Date.now();`:
    `const send = sendTargets.length > 0 ? { targets: sendTargets, now } : null;`. Pass `send={send}` to
    `DiskSetSection` and to every `DiskRow`, and put `<SendBoardPicker ctx={send} />` as the first child of the
    `flex flex-col gap-3 px-4 pb-10 sm:px-7` div.

- [ ] **Step 6: Run the e2e and the touched pages' specs**

Run: `pnpm exec tsc --noEmit && pnpm lint && PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts e2e/adf-browser.spec.ts e2e/game-detail.spec.ts --project=desktop > /tmp/e2e-send.log 2>&1; tail -15 /tmp/e2e-send.log`
Expected: tsc 0, lint clean, 0 failed (6 send tests + the two pages' specs).

- [ ] **Step 7: Commit**

```bash
git add src/components/send/send-button.tsx src/components/disks/file-tree.tsx "src/app/(app)/disks/[id]/files/page.tsx" \
        src/components/games/disk-row.tsx src/components/games/disk-set-section.tsx "src/app/(app)/games/[id]/page.tsx" \
        e2e/send-to-amiga.spec.ts
git commit -m "disk pages: Send on a file or folder in Browse, Send .adf to Amiga on a disk row, one remembered board"
```

---

### Task 8: The board card's line

**Files:**
- Modify: `src/lib/live-state.ts`, `src/lib/live-state.test.ts`
- Modify: `src/app/(app)/devices/page.tsx`, `src/components/devices/device-list.tsx`, `src/components/devices/device-card.tsx`
- Modify: `e2e/send-to-amiga.spec.ts` (one test)

**Interfaces:**
- Consumes: Task 2 `cardSendLine`, `receiverRunning`, `RX_FRESH_MS`; Task 3 `listSendTargets`, `sendSummaries`.
- Produces: `LiveStateRow` gains `sendVersion: number; sendRx: string | null; sendRxAt: Date | null`;
  `DeviceList` prop `sendLineById: Record<string, string | null>`; `DeviceCard` prop `sendLine?: string | null`;
  test id `device-send-<id>` (a link to `/ingest?board=<id>`).

- [ ] **Step 1: Write the failing tests.** In `live-state.test.ts`, add `sendVersion: 0, sendRx: null, sendRxAt: null,`
  to `base`, and:

```ts
describe('sending to the Amiga (plan 2026-10-17 Task 8)', () => {
  it('moves with the send queue and the receiver state, not with every rx refresh', () => {
    const a = fp([base]);
    expect(fp([{ ...base, sendVersion: 1 }])).not.toBe(a);
    expect(fp([{ ...base, sendRx: 'c', sendRxAt: new Date(NOW - 5_000) }])).not.toBe(a);
    expect(fp([{ ...base, sendRx: 'c', sendRxAt: new Date(NOW - 5_000) }]))
      .toBe(fp([{ ...base, sendRx: 'c', sendRxAt: new Date(NOW - 50_000) }]));
    expect(fp([{ ...base, sendRx: 'c', sendRxAt: new Date(NOW - 5_000) }]))
      .not.toBe(fp([{ ...base, sendRx: 'c', sendRxAt: new Date(NOW - 200_000) }]));
  });
});
```

  Append to `e2e/send-to-amiga.spec.ts`:

```ts
test('the board\'s card says what waits and whether Receive runs, and links to the queue', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'Bench');   // Task 1: the name is kept
  await boardSays(request, token, 'r');
  expect((await page.request.post(`/api/transfers?deviceId=${deviceId}&name=a.txt`, { data: Buffer.from('a'),
    headers: { 'content-type': 'application/octet-stream' } })).status()).toBe(201);
  await page.goto('/devices');
  await expect(page.getByTestId(`device-send-${deviceId}`)).toHaveText('1 file waiting · Receive not running');
  await boardSays(request, token, 'c');
  await expect(page.getByTestId(`device-send-${deviceId}`)).toHaveText('1 file waiting · Receive running', { timeout: LIVE });
  await page.getByTestId(`device-send-${deviceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/ingest\\?board=${deviceId}$`));
  await expect(page.getByTestId('send-board')).toContainText('Bench');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/live-state.test.ts`
Expected: FAIL (`sendVersion: 1` gives the same fingerprint).

- [ ] **Step 3: Implement the fingerprint.** In `src/lib/live-state.ts`:
  - import `RX_FRESH_MS` from `@/lib/send-ui`;
  - `LiveStateRow` gains, before `next`:

```ts
  /** Send to Amiga (Task 8): the card's line reads the queue (sendVersion moves on every queue change) and the
   *  receiver state. Only whether a connected reading is fresh is tracked, not every rx refresh (ruling 18). */
  sendVersion: number; sendRx: string | null; sendRxAt: Date | null;
```

  - in `liveFingerprint`'s line array, after `isOnline(r.lastSeenAt, now) ? '' : relative(r.lastSeenAt, now),` add

```ts
        r.sendVersion, r.sendRx ?? '',
        r.sendRx === 'c' && r.sendRxAt !== null && now - r.sendRxAt.getTime() <= RX_FRESH_MS ? 'fresh' : 'stale',
```

  - in `liveStateRows`'s select, after `df1PickDiskNo: df1Disk.diskNo,` add
    `sendVersion: devices.sendVersion, sendRx: devices.sendRx, sendRxAt: devices.sendRxAt,`.
  - fix any other `LiveStateRow` literal that `tsc` names (e.g. `src/lib/drive-chips.test.ts`'s fixture) by adding
    the same three fields.

- [ ] **Step 4: Implement the card line.**
  - `src/app/(app)/devices/page.tsx`: imports `getDb`, `listSendTargets`, `sendSummaries`, `cardSendLine`,
    `receiverRunning`. Move `const now = Date.now();` above the first `Promise.all`, and after the `nextById` block add:

```ts
  // The card's send line (spec §4): what waits or happened lately, and whether Receive runs, per sending board.
  const [sendTargets, summaries] = await Promise.all([listSendTargets(getDb(), orgId, now), sendSummaries(getDb(), orgId, new Date(now))]);
  const sendLineById = Object.fromEntries(sendTargets.map((t) => {
    const s = summaries[t.id];
    return [t.id, cardSendLine(s, receiverRunning(t, (s?.sending ?? 0) > 0, now))];
  }));
```

    and pass `sendLineById={sendLineById}` to `<DeviceList …>`.
  - `device-list.tsx`: the props gain `sendLineById: Record<string, string | null>;` and `<DeviceCard …>` gets
    `sendLine={sendLineById[d.id] ?? null}`.
  - `device-card.tsx`: import `{ Link } from '@/components/shell/link'`; the props gain
    `/** Send to Amiga's one line (spec §4), or null when nothing waits or happened lately. */ sendLine?: string | null;`;
    right before the `{/* BOTTOM: write protection, firmware, and every existing action. */}` block add:

```tsx
      {sendLine && (
        <Link href={`/ingest?board=${encodeURIComponent(device.id)}`} data-testid={`device-send-${device.id}`}
              className="w-fit text-[11px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          {sendLine}
        </Link>
      )}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/lib/live-state.test.ts src/lib/drive-chips.test.ts && pnpm exec tsc --noEmit && pnpm lint && PORT=3100 pnpm exec playwright test e2e/send-to-amiga.spec.ts e2e/devices-page.spec.ts e2e/live-state.spec.ts --project=desktop > /tmp/e2e-send.log 2>&1; tail -15 /tmp/e2e-send.log`
Expected: vitest PASS, tsc 0, lint clean, e2e 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/live-state.ts src/lib/live-state.test.ts src/lib/drive-chips.test.ts "src/app/(app)/devices/page.tsx" \
        src/components/devices/device-list.tsx src/components/devices/device-card.tsx e2e/send-to-amiga.spec.ts
git commit -m "devices: the card's send line (waiting, sending, failed, delivered; Receive running or not), live"
```

---

### Task 9: Receive on the driver disk

**Files:**
- Create: `tools/receive/dist/Receive` (the pinned build, committed; R14)
- Modify: `.github/workflows/receive.yml`, `tools/receive/README.md`
- Modify: `tools/paulanet-disk/build.sh`, `tools/paulanet-disk/make_icon.py`, `tools/paulanet-disk/check.py`,
  `tools/paulanet-disk/Install`, `tools/paulanet-disk/ReadMe`, `tools/paulanet-disk/paulanet-disk.sha256`
- Modify: `docker/Dockerfile` (the `paulanet` stage)
- Modify: `src/lib/paulanet-disk.ts` (the new digest; `PAULANET_DISK_PREVIOUS`)

**Interfaces:**
- Produces: `export const PAULANET_DISK_PREVIOUS = '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e';`
  and a new `PAULANET_DISK_SHA256` (Task 10 uses both). `tools/paulanet-disk/build.sh <out.adf>` needs only xdftool.

- [ ] **Step 1: Write the failing check.** In `tools/paulanet-disk/check.py`, `WANT` becomes:

```python
WANT = {'PaulaNET.device': 13872, 'PaulaNET Config': 55536, 'Install': None, 'Install.info': None,
        'ReadMe': None, 'ReadMe.info': None, 'Receive': None, 'Receive.info': None, 'disk.info': 364}
```

- [ ] **Step 2: Run the build to see it fail**

Run: `tools/paulanet-disk/build.sh /tmp/PaulaNET.adf`
Expected: `FAIL Receive present` and `FAIL Receive.info present`, exit 1.

- [ ] **Step 3: Commit the pinned binary.**

```bash
mkdir -p tools/receive/dist
tools/receive/build.sh tools/receive/dist/Receive
```

Expected: `d19b45e16f72a5a9ef886af128720b2ddec9afd0e562d00a82fc39942d3d64e2  tools/receive/dist/Receive (23840 bytes)`, `PASS pinned`.
In `.github/workflows/receive.yml`, after the `Cross-build matches the pin` step add:

```yaml
      - name: The committed binary is that build (the driver disk and the self-host image use it)
        run: cmp "$RUNNER_TEMP/Receive" tools/receive/dist/Receive
```

In `tools/receive/README.md`, the last bullet of "Testing and building" becomes:

```markdown
- **The binary goes onto the PaulaNET driver disk** from `dist/Receive`, the committed copy of the pinned build
  (CI checks they are identical). After changing the sources: `build.sh dist/Receive --pin`, commit both, then
  rebuild the driver disk (its pin changes too). `Install` copies it to `SYS:Tools/` and `C:`.
```

- [ ] **Step 4: `make_icon.py` learns a tool icon.** Replace the file with:

```python
"""A Workbench icon from a tool icon. Usage:
  make_icon.py <tool.info> <default tool> <out.info>   a project icon with that default tool
  make_icon.py <tool.info> --tool <out.info>          a tool icon (Receive.info): the same picture, placed by Workbench

The input must be a plain OS 2+ tool icon with no default tool, no tool types and
no drawer data (Rob's "PaulaNET Config.info" is one); anything else is refused.
After the images, an icon carries its default tool as a ULONG length (with the NUL)
and the string -- so that is appended, and do_DefaultTool is made non-zero."""
import struct, sys

src, tool, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = bytearray(open(src, 'rb').read())
magic, ver = struct.unpack('>HH', d[0:4])
do_type = d[48]
deftool, tooltypes = struct.unpack('>II', d[50:58])
drawer = struct.unpack('>I', d[66:70])[0]
if (magic, ver, do_type, deftool, tooltypes, drawer) != (0xE310, 1, 3, 0, 0, 0) or b'FORM' in d:
    sys.exit('make_icon: %s is not a plain tool icon' % src)
struct.pack_into('>II', d, 58, 0x80000000, 0x80000000)  # NO_ICON_POSITION: Workbench places it
if tool != '--tool':
    d[48] = 4                                  # WBPROJECT
    struct.pack_into('>I', d, 50, 0x00000001)  # do_DefaultTool: non-zero = present
    s = tool.encode('ascii') + b'\x00'
    d += struct.pack('>I', len(s)) + s
open(out, 'wb').write(bytes(d))
```

- [ ] **Step 5: `build.sh` puts Receive on the disk.** In `tools/paulanet-disk/build.sh`:
  - the header comment's usage line becomes
    `# Usage: tools/paulanet-disk/build.sh <out.adf>     Needs xdftool (amitools 0.4.0). Receive comes from tools/receive/dist/.`
  - after `cp "$base" "$tmp/disk.adf"` add:

```bash
# Receive (spec 2026-10-16 §5): the committed pinned build, checked here so a stale copy fails the disk build.
cp "$repo/tools/receive/dist/Receive" "$tmp/Receive"
[ "$(sha256 "$tmp/Receive")" = "$(cat "$repo/tools/receive/receive.sha256")" ] \
  || { echo "FAIL: tools/receive/dist/Receive is not the binary pinned in tools/receive/receive.sha256"; exit 1; }
```

  - after the two existing `make_icon.py` lines add
    `python3 -I "$here/make_icon.py" "$tmp/tool.info" --tool "$tmp/Receive.info"`
  - the write line becomes:

```bash
( cd "$tmp" && xdf disk.adf write Install + write Install.info + write ReadMe + write ReadMe.info \
                + write Receive + write Receive.info + protect Install srwed + protect Receive rwed )
```

  - after the `PaulaNET.device is the pinned binary` check add:

```bash
xdftool "$tmp/disk.adf" read Receive "$tmp/receive.back"
cmp -s "$tmp/receive.back" "$tmp/Receive" \
  && echo "PASS Receive is the pinned binary" || { echo "FAIL: Receive on the disk differs from tools/receive/dist/"; exit 1; }
```

- [ ] **Step 6: `Install` copies Receive.** In `tools/paulanet-disk/Install`, the header comment becomes

```
; Install -- puts Rob Smith's PaulaNET.device in place for a TCP/IP stack,
; and webadf's Receive in SYS:Tools (with its icon) and C:.
; From webadf (https://github.com/stefanskotte/webadf). Safe to run more
; than once: the driver and Receive are copied again, and an existing eth0
; is never changed.
```

  and after `Echo "Copied PaulaNET.device to DEVS:Networks."` insert:

```
If NOT EXISTS SYS:Tools
  MakeDir SYS:Tools
EndIf
Copy PaulaNET:Receive SYS:Tools/ CLONE QUIET
If WARN
  Skip NORECEIVE
EndIf
Copy PaulaNET:Receive.info SYS:Tools/ CLONE QUIET
If WARN
  Skip NORECEIVE
EndIf
Copy PaulaNET:Receive C: CLONE QUIET
If WARN
  Skip NORECEIVE
EndIf
Echo "Copied Receive to SYS:Tools and C:."
Skip ETH
Lab NORECEIVE
Echo "Could not copy Receive to SYS:Tools and C:."
Echo "The driver is in place; Receive also runs from this disk."
Lab ETH
```

- [ ] **Step 7: `ReadMe` explains it.** Append to `tools/paulanet-disk/ReadMe` (plain ASCII):

```

Receive
=======

Receive saves files you send from the webadf web app into a
folder you choose: from the Upload page (Send to Amiga), from a
disk's Browse page, or a whole disk as an .adf file. Install
copies it to SYS:Tools, with its icon, and to C:.

Start it by hand: double-click its icon, or type Receive in a
Shell. In the window, choose the folder and press Save. The
default folder is RAM:. Close the window to stop. Files sent
while Receive is not running wait on the server for 24 hours.

In a Shell:  Receive [TO <folder>] [SAVE] [GUI]
TO uses a folder for this run, SAVE also stores it, GUI opens
the window. Ctrl-C stops it.

Nothing is overwritten: a second Foo.lha arrives as Foo_2.lha,
and nothing is written outside the folder. While Receive runs,
it listens on TCP port 6800, and any computer on your network
can drop a file into the folder.
```

- [ ] **Step 8: Build, then pin the new disk**

Run: `tools/paulanet-disk/build.sh /tmp/PaulaNET.adf`
Expected: every `PASS` line (Receive present, Receive.info present, cylinders 75-79 allocated, both pinned binaries),
then `FAIL: not the pinned disk (05170a83…) -- an input changed; the server's PAULANET_DISK_SHA256 must change with it`.
Then pin it, and keep the old digest by name:

```bash
sha=$(shasum -a 256 /tmp/PaulaNET.adf | cut -d' ' -f1)
echo "$sha" > tools/paulanet-disk/paulanet-disk.sha256
sed -i '' "s/^export const PAULANET_DISK_SHA256 = '[0-9a-f]\{64\}';/export const PAULANET_DISK_SHA256 = '$sha';/" src/lib/paulanet-disk.ts
tools/paulanet-disk/build.sh /tmp/PaulaNET.adf
```

Expected: the second build ends with `$sha  /tmp/PaulaNET.adf` and no FAIL. In `src/lib/paulanet-disk.ts`, right
under `PAULANET_DISK_BYTES`, add:

```ts
/**
 * The driver disk before Receive (Phase 3, until plan 2026-10-17). Still valid: a board whose Amiga is online keeps it
 * until the Amiga is off (driverDiskFor, R16), so it is served, kept by the blob GC and named on the card.
 */
export const PAULANET_DISK_PREVIOUS = '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e';
```

- [ ] **Step 9: The self-host image carries it.** In `docker/Dockerfile`'s `paulanet` stage, after
  `COPY tools/paulanet-disk tools/paulanet-disk` add:

```dockerfile
# Receive (plan 2026-10-17 R14): the committed pinned build; build.sh checks it against receive.sha256.
COPY tools/receive/dist/Receive tools/receive/dist/Receive
COPY tools/receive/receive.sha256 tools/receive/receive.sha256
```

Run: `docker build -f docker/Dockerfile --target paulanet -t webadf-paulanet-check . > /tmp/docker-pn.log 2>&1; tail -5 /tmp/docker-pn.log`
Expected: the stage builds; the log shows `PASS Receive is the pinned binary` and the new sha.

- [ ] **Step 10: The unit suite still agrees**

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/app/api/paulanet-disk src/app/api/device/image src/app/api/device/poll src/lib/network-checklist.test.ts`
Expected: PASS (they read the constant, not a literal).

- [ ] **Step 11: Commit**

```bash
git add tools/receive/dist/Receive .github/workflows/receive.yml tools/receive/README.md tools/paulanet-disk \
        docker/Dockerfile src/lib/paulanet-disk.ts
git commit -m "driver disk: Receive and its icon on the PaulaNET disk, Install copies it to SYS:Tools and C:, ReadMe; new pin"
```

---

### Task 10: The driver-disk rollout on the server

**Files:**
- Modify: `src/lib/paulanet-disk.ts`, `src/lib/paulanet-disk.test.ts`
- Modify: `src/lib/network-checklist.ts`, `src/lib/network-checklist.test.ts`
- Modify: `src/lib/mount.ts` (`PollTick`, `readPollTick`), `src/app/api/device/poll/route.ts`,
  `src/app/api/device/poll/route.test.ts`

**Interfaces:**
- Consumes: Task 9's `PAULANET_DISK_PREVIOUS`.
- Produces: `export const DRIVER_TALKING_MS = 120_000;` (moved here, re-exported by `network-checklist.ts`);
  `export function isDriverDisk(sha: string | null): boolean;`
  `export function driverDiskFor(t: { df1Sha256: string | null; netDriverSeenAt: Date | null }, now: number): string;`
  `PollTick` gains `df1Sha256: string | null; netDriverSeenAt: Date | null;`.

- [ ] **Step 1: Write the failing tests.** In `src/lib/paulanet-disk.test.ts`:

```ts
import { PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256, ALWAYS_REFERENCED_BLOBS, driverDiskFor, isDriverDisk,
  netNextRearmCandidate, servedWithoutEntitlement } from './paulanet-disk';

describe('the driver disk rollout (plan 2026-10-17 R16)', () => {
  const NOW = 1_800_000_000_000;
  it('keeps the older disk while the Amiga\'s driver talks, never swapping DF1 under it', () => {
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - 10_000) }, NOW)).toBe(PAULANET_DISK_PREVIOUS);
  });
  it('names the new disk once the driver is quiet, or to a board that holds neither', () => {
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(NOW - 200_000) }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: null }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: null, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
    expect(driverDiskFor({ df1Sha256: PAULANET_DISK_SHA256, netDriverSeenAt: new Date(NOW) }, NOW)).toBe(PAULANET_DISK_SHA256);
  });
  it('serves and keeps both digests, and nothing else', () => {
    expect(isDriverDisk(PAULANET_DISK_PREVIOUS) && isDriverDisk(PAULANET_DISK_SHA256)).toBe(true);
    expect(isDriverDisk('a'.repeat(64)) || isDriverDisk(null)).toBe(false);
    expect(servedWithoutEntitlement(PAULANET_DISK_PREVIOUS)).toBe(true);
    expect([...ALWAYS_REFERENCED_BLOBS].sort()).toEqual([PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256].sort());
  });
  it('a board holding the older disk stays a re-arm candidate, so the new one goes in once the Amiga is off', () => {
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_PREVIOUS })).toBe(true);
    expect(netNextRearmCandidate({ secondDrive: 'net', driveVersion: 1, df1Sha256: PAULANET_DISK_SHA256 })).toBe(false);
  });
});
```

  In `src/lib/network-checklist.test.ts`:

```ts
it('names the older driver disk as in DF1, and says when the new one goes in (R16)', () => {
  expect(driverDiskLine({ df1Sha256: PAULANET_DISK_PREVIOUS }))
    .toEqual({ ok: true, text: 'Driver disk: in DF1 (the older one, without Receive; the new one goes in once the Amiga is off)' });
});
```

  (import `PAULANET_DISK_PREVIOUS` from `@/lib/paulanet-disk`). In `src/app/api/device/poll/route.test.ts`, add
  `df1Sha256: null, netDriverSeenAt: null,` to `baseTick`, import `PAULANET_DISK_PREVIOUS`, and inside the
  describe that defines `applied`:

```ts
  it('a netPick board holding the older driver disk keeps it while its driver talks, and gets the new one after (R16)', async () => {
    const { GET } = await import('./route');
    readDf1ForPoll.mockResolvedValue({ v: 6, sha256: null });
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied, netNextSentVersion: 3,
      df1Version: 6, df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(Date.now() - 10_000) }));
    expect((await (await GET(get('?since=1&driveAck=3&df1Ack=6&netPick=1'))).json()).df1).toEqual({ v: 6, sha256: PAULANET_DISK_PREVIOUS });
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied, netNextSentVersion: 3,
      df1Version: 6, df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(Date.now() - 600_000) }));
    expect((await (await GET(get('?since=1&driveAck=3&df1Ack=6&netPick=1'))).json()).df1).toEqual({ v: 6, sha256: PAULANET_DISK_SHA256 });
  });
  it('a board without netPick gets the same choice in next', async () => {
    const { GET } = await import('./route');
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied, netNextSentVersion: 3,
      df1Sha256: PAULANET_DISK_PREVIOUS, netDriverSeenAt: new Date(Date.now() - 10_000) }));
    expect((await (await GET(get('?since=1&driveAck=3'))).json()).next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_PREVIOUS, diskNo: 1 });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/app/api/device/poll/route.test.ts`
Expected: FAIL: `driverDiskFor is not a function`, the checklist text, and the poll still naming the new digest.

- [ ] **Step 3: Implement.** In `src/lib/paulanet-disk.ts`:

```ts
/** Two heartbeats (60 s each, DC_STATUS_PERIOD_MS): within this the Amiga's driver is "talking" (moved here from
 *  network-checklist.ts so driverDiskFor can use it without an import cycle). */
export const DRIVER_TALKING_MS = 120_000;

export const isDriverDisk = (sha: string | null): boolean => sha === PAULANET_DISK_SHA256 || sha === PAULANET_DISK_PREVIOUS;

/**
 * Which driver disk the poll names for DF1 in Network mode (R16). A board holding the older disk keeps it while
 * the Amiga's driver talks, so DF1 is never swapped (shown empty for 1 s, then changed) under a running network;
 * otherwise the new one. The 5-minute re-arm (netNextRearm) keeps waking such a board, so the new disk goes in
 * within minutes of the Amiga being switched off.
 */
export function driverDiskFor(t: { df1Sha256: string | null; netDriverSeenAt: Date | null }, now: number): string {
  const talking = t.netDriverSeenAt !== null && now - t.netDriverSeenAt.getTime() <= DRIVER_TALKING_MS;
  return t.df1Sha256 === PAULANET_DISK_PREVIOUS && talking ? PAULANET_DISK_PREVIOUS : PAULANET_DISK_SHA256;
}
```

  and change `ALWAYS_REFERENCED_BLOBS` to `[PAULANET_DISK_SHA256, PAULANET_DISK_PREVIOUS]` and
  `servedWithoutEntitlement` to `return isDriverDisk(sha256);` (the doc comment: "The driver disks (current and
  previous, R16): the only images ..."). Leave `netNextRearmCandidate` as it is, and add to its doc comment:
  "A board holding PAULANET_DISK_PREVIOUS is a candidate on purpose: the re-arm is what delivers the new disk once the
  driver goes quiet (R16)."

  In `src/lib/network-checklist.ts`: `import { DRIVER_TALKING_MS, PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';`,
  replace `export const DRIVER_TALKING_MS = 120_000;` with `export { DRIVER_TALKING_MS };`, and `driverDiskLine` becomes:

```ts
export function driverDiskLine(d: { df1Sha256: string | null }): Line {
  if (d.df1Sha256 === PAULANET_DISK_SHA256) return { ok: true, text: 'Driver disk: in DF1' };
  if (d.df1Sha256 === PAULANET_DISK_PREVIOUS) {
    return { ok: true, text: 'Driver disk: in DF1 (the older one, without Receive; the new one goes in once the Amiga is off)' };
  }
  return { ok: false, text: 'Driver disk: loading' };
}
```

  In `src/lib/mount.ts`, `PollTick` gains

```ts
  /** What DF1 holds and when the Amiga's driver last read: driverDiskFor's inputs (plan 2026-10-17 R16). */
  df1Sha256: string | null;
  netDriverSeenAt: Date | null;
```

  and `readPollTick`'s select gains `df1Sha256: devices.df1Sha256, netDriverSeenAt: devices.netDriverSeenAt,`.
  In `src/app/api/device/poll/route.ts`: the import adds `driverDiskFor`; right before `const next = …` add
  `const driverSha = driverDiskFor(tick, Date.now());   // R16`; then
  `const next = netNext && !netPick ? { ...PAULANET_NEXT }` becomes `… ? { ...PAULANET_NEXT, sha256: driverSha }`, and
  `{ v: df1Read.v, sha256: PAULANET_DISK_SHA256 }` becomes `{ v: df1Read.v, sha256: driverSha }`. Drop
  `PAULANET_DISK_SHA256` from the import if nothing else uses it.

- [ ] **Step 4: Run them to see them pass, with the neighbours**

Run: `pnpm vitest run src/lib/paulanet-disk.test.ts src/lib/network-checklist.test.ts src/app/api/device/poll src/app/api/device/image src/lib/blob-gc && pnpm exec tsc --noEmit`
Expected: PASS, tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paulanet-disk.ts src/lib/paulanet-disk.test.ts src/lib/network-checklist.ts src/lib/network-checklist.test.ts \
        src/lib/mount.ts src/app/api/device/poll/route.ts src/app/api/device/poll/route.test.ts
git commit -m "driver disk rollout: a board whose Amiga is online keeps the older disk until the Amiga is off (R16)"
```

---

### Task 11: The IP gap, server half: the Amiga's last address in `xfer.ip`

**Files:**
- Modify: `src/db/schema/devices.ts`; Generate: `drizzle/0042_amiga_ip_last.sql` (+ journal, snapshot)
- Modify: `src/lib/mount.ts` (`recordStatus`, `PollTick`, `readPollTick`), `src/app/api/device/poll/route.ts`
- Test: `src/lib/mount-record-status.test.ts`, `src/app/api/device/poll/route.test.ts`, `src/lib/device-limits.test.ts`

**Interfaces:**
- Produces: `devices.netAmigaIpLast` (`net_amiga_ip_last text`), `PollTick.netAmigaIpLast: string | null`, and on the
  wire `xfer: { v: number, ip?: string }` to every board that sends `xferAck` (Task 12 reads `ip`).

- [ ] **Step 1: Write the failing tests.** In `mount-record-status.test.ts`, inside `describe('recordStatus net (Phase 3)')`:

```ts
  it('remembers the last address the board heard, and keeps it when a report has none (R17)', async () => {
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.15.0+gabc', secondDrive: 'net', net: { amigaIp: '172.16.10.237', framesIn: 0, framesOut: 0 } });
    expect(patches[0].netAmigaIpLast).toBe('172.16.10.237');
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.15.0+gabc', secondDrive: 'net', net: { framesIn: 0, framesOut: 0 } });
    expect(patches[1]).not.toHaveProperty('netAmigaIpLast');
    expect(patches[1].netAmigaIp).toBeNull();                 // the card still says "none yet"
    await recordStatus('dev-1', { ...base, firmwareVersion: '1.15.0+gabc', secondDrive: 'off' });
    expect(patches[2]).not.toHaveProperty('netAmigaIpLast');
  });
```

  In `poll/route.test.ts`, add `netAmigaIpLast: null,` to `baseTick`, and in the xfer describe:

```ts
  it('carries the Amiga\'s last address in xfer.ip, so a rebooted board can reach an idle Amiga (R17)', async () => {
    readPollTick.mockResolvedValue(baseTick({ sendVersion: 3, netAmigaIpLast: '172.16.10.237' }));
    const { GET } = await import('./route');
    expect((await (await GET(get('?since=1&xferAck=0'))).json()).xfer).toEqual({ v: 3, ip: '172.16.10.237' });
  });
  it('sends no ip when none was ever heard, and never to a board without xferAck', async () => {
    const { GET } = await import('./route');
    readPollTick.mockResolvedValue(baseTick({ sendVersion: 3 }));
    expect((await (await GET(get('?since=1&xferAck=0'))).json()).xfer).toEqual({ v: 3 });
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, netAmigaIpLast: '172.16.10.237' }));
    expect(await (await GET(get('?since=1'))).json()).not.toHaveProperty('xfer');
  });
```

  In `device-limits.test.ts`: in the worst-case body test, `xfer` becomes
  `const xfer = ',"xfer":{"v":4294967295,"ip":"255.255.255.255"}';`, and add a test:

```ts
  // Review Focus 4: 1.14.0 and 1.15.0 copy `xfer` into a 48-byte buffer (dc_take_xfer's `static char obj[48]`), and
  // json_object refuses an object that does not fit -- those boards would then drop xfer whole and never send again.
  it('keeps the worst xfer object inside the 48-byte buffer every sending board has', () => {
    expect(Buffer.byteLength('{"v":4294967295,"ip":"255.255.255.255"}', 'utf8') + 1).toBeLessThanOrEqual(48);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/mount-record-status.test.ts src/app/api/device/poll/route.test.ts src/lib/device-limits.test.ts`
Expected: FAIL: `netAmigaIpLast` undefined in the patch, and `xfer` equal to `{ v: 3 }` (no ip). The limits tests pass
already (1,603 bytes of 1,664; 40 of 48): they are guards, recorded here so a later field cannot break them.

- [ ] **Step 3: Schema and migration.** In `src/db/schema/devices.ts`, after `netAmigaIp`:

```ts
  /** The last Amiga address any report carried, never cleared by a report without one (plan 2026-10-17 R17). The
   *  poll sends it as xfer.ip, so a board that rebooted can reach an Amiga that has not transmitted since. */
  netAmigaIpLast: text('net_amiga_ip_last'),
```

Run: `pnpm db:generate --name amiga_ip_last && cat drizzle/0042_amiga_ip_last.sql`
Expected: `ALTER TABLE "devices" ADD COLUMN "net_amiga_ip_last" text;`

- [ ] **Step 4: Record and send it.** In `src/lib/mount.ts` `recordStatus`, inside `if (s.net !== undefined) {`, after
  `patch.netAmigaIp = s.net.amigaIp ?? null;`:

```ts
    // R17: kept across reports that lack it (a rebooted board knows none until the Amiga transmits).
    if (s.net.amigaIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(s.net.amigaIp)) patch.netAmigaIpLast = s.net.amigaIp;
```

  `PollTick` gains `/** The Amiga's last address (R17): sent as xfer.ip. */ netAmigaIpLast: string | null;` and
  `readPollTick`'s select gains `netAmigaIpLast: devices.netAmigaIpLast,`. In the poll route, the `xfer` line becomes:

```ts
          // The send queue's cursor (PaulaNET Phase 4), and the Amiga's last address (R17): 1.16.0 seeds its sorter with
          // it after a reboot. Older senders ignore `ip`; the object stays under their 48-byte buffer (device-limits).
          ...(xferAck !== null
            ? { xfer: { v: tick.sendVersion, ...(tick.netAmigaIpLast ? { ip: tick.netAmigaIpLast } : {}) } }
            : {}),
```

- [ ] **Step 5: Run them to see them pass, and the device e2e**

Run: `pnpm vitest run src/lib/mount-record-status.test.ts src/app/api/device/poll src/lib/device-limits.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, tsc 0.
The e2e runs against production's database, which does not have column 0042 until Task 13 Step 4. From this task on,
run no e2e that polls or reports status (every spec in `send-to-amiga.spec.ts` does) until that migration; Task 13
Step 3 runs them all after it.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/devices.ts drizzle/0042_amiga_ip_last.sql drizzle/meta src/lib/mount.ts \
        src/app/api/device/poll/route.ts src/app/api/device/poll/route.test.ts src/lib/mount-record-status.test.ts \
        src/lib/device-limits.test.ts
git commit -m "poll: the Amiga's last address rides xfer.ip (migration 0042 net_amiga_ip_last), for boards that rebooted (R17)"
```

---

### Task 12: The IP gap, firmware half (ships in 1.16.0)

**Files:**
- Modify: `wifi-floppy/firmware/src/pnet_sort.h`, `pnet_sort.c`; Test: `wifi-floppy/firmware/test/test_pnet_sort.c`
- Modify: `wifi-floppy/firmware/src/device_client.h`, `device_client.c`; Test: `wifi-floppy/firmware/test/test_device_client.c`
- Modify: `wifi-floppy/firmware/src/pnet_bridge.h`, `pnet_bridge.c` (device-only), `src/main.c`, `CMakeLists.txt`

**Interfaces:**
- Consumes: Task 11's `xfer.ip`.
- Produces: `bool pnet_sort_seed(pnet_sort_t *s, uint32_t ip, uint32_t board_ip);`
  `bool dc_parse_ipv4(const char *s, uint32_t *out);` `device_client_t.send_ip_hint` (`uint32_t`, host order, 0 = none);
  `void pnet_bridge_seed_amiga_ip(uint32_t ip);`; log line `pnet: Amiga address <ip> from the server (not seen since boot)`.

- [ ] **Step 1: Write the failing host tests.** In `test/test_pnet_sort.c`, before `main`:

```c
/* Plan 2026-10-17 R17: after a reboot the sorter knows no Amiga until it transmits; the server's last-known address
 * seeds it. A seed never replaces an address learned from the Amiga, and is never the board's own. */
static void a_seed_fills_only_an_unknown_address(void) {
    pnet_sort_t s = fresh(0);
    CHECK(pnet_sort_seed(&s, AMIGA, BOARD), "an unknown address takes the seed");
    CHECK_EQ_INT(s.amiga_ip, AMIGA);
    CHECK(!pnet_sort_seed(&s, IP(192, 168, 1, 99), BOARD), "a known address is never replaced by a seed");
    CHECK_EQ_INT(s.amiga_ip, AMIGA);
    pnet_sort_t t = fresh(0);
    CHECK(!pnet_sort_seed(&t, BOARD, BOARD), "never the board's own address");
    CHECK(!pnet_sort_seed(&t, 0, BOARD), "0 is not an address");
    CHECK_EQ_INT(t.amiga_ip, 0);
}

/* The board's own connect attempt is the probe: lwIP's ARP for the seeded address goes to the Amiga locally; an
 * Amiga that moved teaches its new address with its first frame. */
static void a_seeded_address_takes_the_boards_arp_and_relearns(void) {
    pnet_sort_t s = fresh(0);
    CHECK(pnet_sort_seed(&s, AMIGA, BOARD), "seeded");
    size_t n = arp(BCAST, MAC, 1, BOARD, AMIGA);
    CHECK(pnet_sort_b2a_local(&s, F, n, BOARD), "the board's ARP for the seeded address goes to the Amiga");
    n = arp(BCAST, MAC, 1, IP(192, 168, 1, 58), ROUTER);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, IP(192, 168, 1, 58));
}
```

  and in `main`, after the last `RUN(...)`: `RUN(a_seed_fills_only_an_unknown_address); RUN(a_seeded_address_takes_the_boards_arp_and_relearns);`.

  In `test/test_device_client.c`, after `send_version_is_read_from_the_poll`:

```c
static void send_ip_hint_is_read_from_xfer(void) {
    boot(); dc_set_send(&c, 0, '-');
    CHECK_EQ_INT(c.send_ip_hint, 0);
    push_ok_json("{\"version\":3,\"desired\":null,\"xfer\":{\"v\":7,\"ip\":\"172.16.10.237\"}}");
    dc_step(&c);
    CHECK_EQ_INT(c.send_version, 7);
    CHECK_EQ_INT(c.send_ip_hint, 0xAC100AEDu);
    push_ok_json("{\"version\":4,\"desired\":null,\"xfer\":{\"v\":8,\"ip\":\"172.16.10.2370000000000\"}}");
    dc_step(&c);
    CHECK_EQ_INT(c.send_version, 8);                   // a bad ip never costs the cursor
    CHECK_EQ_INT(c.send_ip_hint, 0xAC100AEDu);         // and leaves the last good hint
}

static void parse_ipv4_is_strict(void) {
    uint32_t v = 1;
    CHECK(dc_parse_ipv4("192.168.1.57", &v) && v == 0xC0A80139u, "a dotted quad");
    CHECK(!dc_parse_ipv4("192.168.1", &v), "three parts");
    CHECK(!dc_parse_ipv4("192.168.1.256", &v), "over 255");
    CHECK(!dc_parse_ipv4("192.168.1.5x", &v), "trailing junk");
    CHECK(!dc_parse_ipv4("1.2.3.4567", &v), "four digits");
    CHECK(!dc_parse_ipv4("", &v), "empty");
    CHECK(!dc_parse_ipv4("0.0.0.0", &v), "zero is no address");
    CHECK(v == 0xC0A80139u, "a refusal leaves *out alone");
}
```

  and add `RUN(send_ip_hint_is_read_from_xfer); RUN(parse_ipv4_is_strict);` to the line that runs
  `send_version_is_read_from_the_poll`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm firmware:test > /tmp/fw-test.log 2>&1; grep -E "COMPILE FAIL|test_pnet_sort|test_device_client" /tmp/fw-test.log`
Expected: `COMPILE FAIL: test_pnet_sort.c` and `COMPILE FAIL: test_device_client.c` (implicit `pnet_sort_seed`,
`dc_parse_ipv4`, no member `send_ip_hint`).

- [ ] **Step 3: Implement the pure parts.** `pnet_sort.h`, after `pnet_sort_tx`'s declaration:

```c
/* Plan 2026-10-17 R17 (fw 1.16.0): the server's last-known Amiga address, for a board that rebooted and has heard
 * nothing from the Amiga since. Fills amiga_ip only when it is 0; never 0, never the board's own. True = seeded. */
bool pnet_sort_seed(pnet_sort_t *s, uint32_t ip, uint32_t board_ip);
```

  `pnet_sort.c`, after `pnet_sort_tx`:

```c
bool pnet_sort_seed(pnet_sort_t *s, uint32_t ip, uint32_t board_ip) {
    if (s->amiga_ip != 0u || ip == 0u || ip == board_ip) return false;
    s->amiga_ip = ip;
    return true;
}
```

  `device_client.h`: after `bool send_seen;` add

```c
    // The server's last-known Amiga address (xfer.ip, fw 1.16.0, host order; 0 = none): main.c seeds the PaulaNET
    // sorter with it when the sorter knows none (plan 2026-10-17 R17).
    uint32_t send_ip_hint;
```

  and near `dc_set_send`'s declaration:

```c
// A strict dotted quad ("192.168.1.57" -> 0xC0A80139). False for anything else, and for 0.0.0.0; *out untouched then.
bool dc_parse_ipv4(const char *s, uint32_t *out);
```

  `device_client.c`: `dc_take_xfer` becomes

```c
static void dc_take_xfer(device_client_t *c, char *json) {
    static char obj[48];   // {"v":4294967295,"ip":"255.255.255.255"} is 39; 1.14.0/1.15.0 have the same 48 (device-limits test)
    if (!json_object(json, "xfer", obj, sizeof obj, true)) return;
    uint32_t v;
    if (!json_u32_strict(obj, "v", &v)) return;
    c->send_version = v;
    c->send_seen = true;
    // json_str truncates silently: 20 bytes, so a cut value is at least 19 characters and never parses (a quad is <= 15).
    char ip[20];
    uint32_t hint;
    if (json_str(obj, "ip", ip, sizeof ip) && dc_parse_ipv4(ip, &hint)) c->send_ip_hint = hint;
}

bool dc_parse_ipv4(const char *s, uint32_t *out) {
    uint32_t v = 0;
    for (int part = 0; part < 4; part++) {
        if (part > 0) { if (*s != '.') return false; s++; }
        if (*s < '0' || *s > '9') return false;
        unsigned n = 0;
        int digits = 0;
        while (*s >= '0' && *s <= '9') {
            if (++digits > 3) return false;
            n = n * 10u + (unsigned)(*s - '0');
            s++;
        }
        if (n > 255u) return false;
        v = v << 8 | n;
    }
    if (*s != '\0' || v == 0u) return false;
    *out = v;
    return true;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm firmware:test > /tmp/fw-test.log 2>&1; grep -E "FAIL|CRASHED|test_pnet_sort.c:|test_device_client.c:" /tmp/fw-test.log; echo "exit=$?"`
Expected: `test_pnet_sort.c: N checks, 0 failed`, `test_device_client.c: N checks, 0 failed`, no FAIL/CRASHED line.

- [ ] **Step 5: The device-only glue.** `pnet_bridge.h`, after `pnet_bridge_check`:

```c
void pnet_bridge_seed_amiga_ip(uint32_t ip); // core1: the server's last-known Amiga address when the sorter has none (1.16.0)
```

  `pnet_bridge.c`, after `pnet_bridge_stats`:

```c
// Plan 2026-10-17 R17: s_sort lives in the network context, so the seed is taken under the lwIP lock. Seeded once:
// the next frame from the Amiga, or the board's own connect (ARP over the local path), confirms or replaces it.
void pnet_bridge_seed_amiga_ip(uint32_t ip) {
    net_radio_lock();
    const bool seeded = pnet_sort_seed(&s_sort, ip, s_board_ip);
    net_radio_unlock();
    if (seeded) {
        char a[16];
        pnet_ip_text(ip, a);
        wf_logf(WF_INFO, "pnet: Amiga address %s from the server (not seen since boot)", a);
    }
}
```

  `main.c`, in the `if (g_df1_mode == DF1_MODE_NET) {` branch, replace `pnet_bridge_stats(&st);` with:

```c
                pnet_bridge_stats(&st);
                // HANDOFF 3bu product gap: after a reboot the sorter knows no Amiga until it transmits, so a file for
                // an idle Amiga waited. The server remembers the last address (xfer.ip, plan 2026-10-17 R17).
                if (st.amiga_ip == 0u && c.send_ip_hint != 0u) {
                    pnet_bridge_seed_amiga_ip(c.send_ip_hint);
                    pnet_bridge_stats(&st);
                }
```

  `CMakeLists.txt`: `set(FIRMWARE_SEMVER "1.15.0")` becomes `set(FIRMWARE_SEMVER "1.16.0")` (R18): master now carries
  the next minor, which the LZ4 driver work joins. If that work has already bumped it on master, leave it at 1.16.0.

- [ ] **Step 6: Build**

Run:

```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
export PORTAL_AP_PASSWORD=<any WPA2 PSK, 8-63 chars>
pnpm firmware:build > /tmp/fw-build.log 2>&1; tail -5 /tmp/fw-build.log; grep -c "warning:" /tmp/fw-build.log
pnpm firmware:test > /tmp/fw-test.log 2>&1; tail -3 /tmp/fw-test.log
```

Expected: the build links, the version reads `1.16.0+g<sha>`, 0 new warnings; host tests 0 failed. If the version
reads 1.15.0, the build dir caches it: `cmake -U FIRMWARE_SEMVER -B wifi-floppy/firmware/build` and build again.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_sort.h wifi-floppy/firmware/src/pnet_sort.c wifi-floppy/firmware/src/device_client.h \
        wifi-floppy/firmware/src/device_client.c wifi-floppy/firmware/src/pnet_bridge.h wifi-floppy/firmware/src/pnet_bridge.c \
        wifi-floppy/firmware/src/main.c wifi-floppy/firmware/CMakeLists.txt \
        wifi-floppy/firmware/test/test_pnet_sort.c wifi-floppy/firmware/test/test_device_client.c
git commit -m "fw (1.16.0): a rebooted board seeds the Amiga's address from the server (xfer.ip), so a send to an idle Amiga starts"
```

---

### Task 13: Review, rollout and the A500 bench

**Files:**
- Modify: `HANDOFF.md` (new section 3bv); the ledger for this plan under `.superpowers/sdd/`

- [ ] **Step 1: Whole-branch review** (most capable model) against the spec and this plan's rulings, then fix
  Critical and Important findings with TDD, as executing-plans says, and review the fixes too.

- [ ] **Step 2: Unit, types, lint, build**

Run: `pnpm vitest run > /tmp/vitest.log 2>&1; tail -5 /tmp/vitest.log && pnpm exec tsc --noEmit && pnpm lint && pnpm build > /tmp/build.log 2>&1; tail -3 /tmp/build.log`
Expected: vitest 0 failed; tsc 0; lint clean; the build ends with the route table and no error.
And with the dev database: `TEST_DATABASE_URL=<url> pnpm test:db src/lib/transfers.db.test.ts src/lib/send-targets.db.test.ts`
Expected: PASS.

- [ ] **Step 3: e2e for the touched areas** (PORT=3100, one at a time, each under 9 minutes, waiting for the teardown
  line between runs). **Do Steps 4 and 5 first:** since Task 11, every spec that polls or reports status reads
  column 0042, which the production database must have, and 3d reads the new driver disk from the store.
  - 3a: `e2e/send-to-amiga.spec.ts e2e/ingest-ui.spec.ts e2e/url-upload.spec.ts e2e/archive-drop.spec.ts`
  - 3b: `e2e/adf-browser.spec.ts e2e/disk-files-edit.spec.ts e2e/disk-drag-drop.spec.ts e2e/time-machine.spec.ts`
  - 3c: `e2e/pairing.spec.ts e2e/device-alias.spec.ts e2e/game-detail.spec.ts e2e/disk-sets.spec.ts e2e/nfc-fob-button.spec.ts e2e/devices-page.spec.ts e2e/live-state.spec.ts`
  - 3d: `e2e/second-drive.spec.ts e2e/device-image.spec.ts e2e/device-poll.spec.ts e2e/device-status.spec.ts e2e/device-send.spec.ts e2e/device-protocol.spec.ts e2e/help.spec.ts`
  - 3e (mobile project): `e2e/mobile.spec.ts e2e/help.mobile.spec.ts`

  Run each as: `PORT=3100 pnpm exec playwright test <files> --project=desktop > /tmp/e2e-3x.log 2>&1; tail -15 /tmp/e2e-3x.log`
  (3e with `--project=mobile`). Expected: 0 failed in each. A failure in the first two tests of a cold run is the
  known compile flake: re-run that spec alone before calling it a regression.

- [ ] **Step 4: Apply migrations 0041 and 0042 to production** (approved 2026-10-17; additive, two nullable text
  columns). Say so in the conversation first, then `pnpm db:migrate`. Expected: `0041_pairing_name` and
  `0042_amiga_ip_last` applied (0041 may already be applied by Task 1's e2e step). Self-hosted copies apply it at their next
  start (docker/ctl.ts runs the migrations).

- [ ] **Step 5: Upload the new driver disk to the production store** (approved 2026-10-17), before the deploy (a
  board may ask for it as soon as the new server names it):
  `pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf`
  Expected: `stored adf/<new sha>, read back and verified` (or `already stored`).

- [ ] **Step 6: Self-host parity check.** `bash scripts/docker-smoke.sh > /tmp/smoke.log 2>&1; tail -5 /tmp/smoke.log`
  Expected: `smoke: PaulaNET disk OK` with the new digest, and the smoke's own PASS lines.

- [ ] **Step 7: Merge `feat/send-web` into master and push** (approved 2026-10-17; master deploys production; the
  firmware change rides along at 1.16.0 and is installed only as a TEST build). Then
  check production in the browser: while the bench Amiga runs, its card reads "Driver disk: in DF1 (the older one,
  …)" (R16), and the Upload page shows the Send to Amiga column with the bench board and its receiver line.

- [ ] **Step 8: The A500 bench, part 1 (board on 1.15.0, the new server).** Ask the operator, at the end of a turn,
  to switch the Amiga on (or off for 3 minutes first, so DF1 takes the new driver disk: the card then reads
  "Driver disk: in DF1"). Then, one step at a time:
  1. **Reinstall:** open DF1, double-click Install. `SYS:Tools/Receive`, its icon and `C:Receive` exist; Install
     says "Copied Receive to SYS:Tools and C:.". Run Install a second time: same result, eth0 untouched.
  2. **Start Receive** from its icon in SYS:Tools, choose `DH0:Downloads`, press Save. The Upload page says
     "✓ Receive is running on the Amiga" within 75 s.
  3. **Send three ways:** an LHA from the computer (Upload page drop zone), a folder from a library disk (Browse →
     Send on the folder), and a whole disk (title page → Send .adf to Amiga). All three read
     "Delivered · saved as …" and the files are in `DH0:Downloads` (the folder with its sub-path; `list` shows the
     disk file's protection and comment).
  4. **Queue while Receive is closed:** close the window; send a file. The Upload page says "Start Receive on the
     Amiga", the card says "1 file waiting · Receive not running". Start Receive: it arrives.
  5. **Cancel a waiting file:** with Receive running, send two 880 KB ADFs; cancel the second while the first moves.
     It reads Cancelled on the web and leaves Receive's window list.
  6. **Cancel mid-file:** send an 880 KB ADF; press Cancel at about 30 %. It reads Cancelled; Receive shows the file
     failed; no `.webadf-rx` is left in the folder; the next file still arrives.
  7. **A 200-byte path:** on a yes (it writes production),
     `pnpm send:queue <deviceId> /tmp/p.txt "$(printf 'Folder%dxxxxxxxxxxxxxxxxxxxxx/' 0 1 2 3 4 5 6)p.txt"`.
     It arrives under the seven folders, and the Upload page shows the saved path whole (also on a phone).
  8. **The Shell form:** close the window, `Receive TO RAM:` in a Shell, send a file: one line
     `<path>  <bytes> bytes  OK`; Ctrl-C stops it.
  9. **Network during a transfer:** ping the router from the Amiga during an ADF transfer; note the times and the
     transfer's duration.
  10. **A phone:** send a file from the Upload page on a phone and watch it arrive.
  Record every result, number and surprise in the ledger.

- [ ] **Step 9: A TEST build of master on the bench board** (R18; never a release).
  - Build master (`1.16.0+g<sha>`), publish with `pnpm firmware:publish --no-github` as HANDOFF 3bm describes for
    TEST builds, with notes `TEST build -- 1.16.0 pre-release: the Amiga's address from the server (no LZ4 yet)`.
    Then read the row back and check its notes start with exactly `TEST build` (HANDOFF 3bu incident: other orgs see
    anything else) before installing.
  - Install it as HANDOFF 3bu says (operator, 2026-10-17: with the Amiga on; Ctrl+Alt+Del it so PaulaNET releases the
    OTA). Confirm "update to 1.16.0+g… confirmed", and read the heap low-water against 28,672. Do not promote it.

- [ ] **Step 10: The A500 bench, part 2 (the IP gap).** With Receive running and no `ping` on the Amiga: reboot the
  board (`wf reboot` on the USB console). Do not touch the Amiga. Send a file from the web. It arrives without the
  `ping -i 10` workaround, and the board's log shows `pnet: Amiga address <ip> from the server (not seen since boot)`
  and `xfer: receiver connected <ip>`. Then change nothing else and confirm DF0 mount, Next and the card are as before.

- [ ] **Step 11: HANDOFF.** Add `### 3bv. PaulaNET Phase 4 increment 3: the web sends; Receive on the driver disk;
  pairing names; IP fix on master for 1.16.0` with: what shipped (pairing name, routes, Upload column, shortcuts,
  card line, help), the new disk digest and the rollout rule (R16), the IP fix (R17, R18) and its TEST-build bench
  result, every bench step's result and numbers, the rulings R1-R18, and the deferred items (below). Master's
  `FIRMWARE_SEMVER` is 1.16.0 and unreleased: the LZ4 work continues on it.

```bash
git add HANDOFF.md
git commit -m "HANDOFF 3bv: send from the web, Receive on the driver disk, pairing names; IP fix on master for 1.16.0"
```

---

## Operator decisions (2026-10-17)

- **Pairing asks for a board name: yes** (R8, Task 1).
- **Browse: one Send button per row for now** (R3). Deferred: a multi-select mode in Browse.
- **Receive keeps Rob's PaulaNET icon picture for now** (R15). Deferred: a picture of our own.
- **The IP fix ships in firmware 1.16.0 with the LZ4 driver work** (R18), not as 1.15.1; this increment only TEST-builds
  master. Firmware promotion is not part of this increment.
- **Approved for this increment:** migrations 0041 and 0042 on production, the driver-disk upload, merging to master
  and pushing.
