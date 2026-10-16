# PaulaNET Phase 4, increment 2: the board sends, the server queues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A file queued on the server for a board reaches `Receive` on that board's Amiga. Firmware 1.14.0 connects
to the Amiga's TCP 6800, fetches the queue and the file in chunks over its HTTPS session, streams them on, and
reports the outcome.

**Architecture:**
- **Server:**
  - a `transfers` table and a `devices.send_version` cursor;
  - three device routes:
    - the queue as ready-made protocol text;
    - a file chunk by `offset`/`length` (the offset doubles as progress);
    - the outcome;
  - a ranged read in the blob store;
  - a `xfer` cursor in the poll;
  - a daily expiry cron.
- **Firmware:**
  - a pure, host-tested state machine (`amiga_send.c`) over an ops table;
  - `device_client` calls for the three routes;
  - lwIP raw-TCP glue (`amiga_tcp.c`, device-only);
  - a branch in core1's loop that, like the uploader, takes over from the long poll while a file is moving.

**Tech Stack:** Next.js route handlers, drizzle + node-postgres, vitest (+ `test:db`); RP2350 firmware C, lwIP raw API
(`NO_SYS=1`, `net_radio_lock`), the firmware host-test harness.

**Spec:** `docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` (§1 D1-D4 and D11, §2, §3, §4's
table, routes, GC and expiry, §7). Increment 1 (`Receive`, `tools/receive/`) is merged (f4ecabe). Increment 3 (the
Upload page's Send to Amiga column, the disk-page shortcuts, the card line, `Receive` on the driver disk) gets its own
plan.

## Global Constraints

- **The firmware is 1.14.0**, and `XFER_FW = '1.14.0'` on the server. Older boards never see `xfer` and are never
  offered as targets.
- **The protocol is spec §2** exactly: TCP 6800, `WEBADF 1`/`READY 1`, `LIST`, `FILE … GO/ERR … OK/ERR`, `PING`/`PONG`.
  Names and comments are ISO-8859-1, length-prefixed.
- **Limits:**
  - 4,194,304 bytes per file; at most 32 queued-or-sending files and 16 MB per board;
  - waiting files expire after 24 h; finished rows are deleted after 7 days;
  - chunks are at most 16,384 bytes.
- **Firmware budgets:**
  - `DC_POLL_BODY_BYTES` (1664) and `DC_STATUS_BODY_BYTES` (1536) are not raised;
  - the queue travels in its own response, at most `SEND_QUEUE_BYTES` = 6144 bytes;
  - the poll's `path` buffer grows to fit the new parameters, with its worst case recomputed in a comment.
- **One HTTPS connection at a time** (`transport_tls.c`). Sending takes turns with the poll: while a file moves, core1
  does not long-poll.
- **lwIP:**
  - every raw-API call is made under `net_radio_lock()`/`net_radio_unlock()`, and the lock is never held across a
    sleep;
  - Amiga→board frames over 256 bytes are dropped by the local path (`PNET_LOCAL_A2B_MAX`); `Receive`'s replies and
    TCP ACKs fit.
- **Production:**
  - `.env.local` holds production secrets: never print them;
  - migration 0040 on production, pushing master, and installing firmware on the board are each asked for first;
  - the Amiga is powered by the operator: ask as the last thing in a turn.
- **e2e:** PORT=3100, one run at a time, chunks under 9 minutes, and only the touched specs.
- **Git:** never `git stash`; never `git add -A`. Work in worktree `.claude/worktrees/send` on branch `feat/send-board`.

**Rulings made while writing this plan:**
- **Ruling: the queue does not travel in the poll body.** It is a separate `GET /api/device/send/queue` returning the
  protocol text, and the poll carries only `xfer: {v}`. 32 entries do not fit `DC_POLL_BODY_BYTES`, and having the
  server write the protocol lines means the firmware forwards them without parsing. Cost if wrong: one request per
  queue change.
- **Ruling: progress is the chunk request's `offset`.** The server records `bytes_sent` from it, so no status-body
  bytes are spent (22 are free) and there are no extra exchanges. Cost: progress lags by one chunk (16 KB).
- **Ruling: the receiver state travels as a poll parameter `rx=c|r|u|-`** (connected / refused / unreachable /
  unknown), stored in `devices.send_rx` and `send_rx_at`.
- **Ruling: transfer bytes live in the existing content-addressed store (`diskStore`, `adf/<sha>`).** It is the one
  prefix blob GC lists, and `transfers.blob_sha256` joins the GC reference list, so queued files are protected and
  finished ones collected. The prefix name is historical. Cost if wrong: a later move to its own prefix.
- **Ruling: a ranged read is added to the blob backends** (local: a file slice; Vercel Blob: `get` with a `Range`
  header, falling back to slicing a full body if the store answers 200). Reading 4 MB for each 16 KB chunk would read
  256 × 4 MB per file.
- **Ruling: the firmware module is `amiga_send`** (`as_` prefix), because `xfer` already names HTTP exchange records
  in `device_client.c` (`dc_xfer_describe`, `last_xfer`).

## Review Focus

1. **The board loses Wi-Fi or reboots mid-file.** The row stays `sending` and must be sent again from the start on the
   next connection. Never mark it delivered, and never give it a second `OK` with half a file. *Pinned in Task 4
   (drop mid-data) and Task 1 (a `sending` row is still NEXT).*
2. **The Amiga user closes `Receive` mid-file** (an RST, or a socket that just closes). The board stops at once,
   reports nothing as delivered, and keeps the file queued. *Task 4.*
3. **A cancel arrives while the file is being sent.** The chunk route answers 409 for a row no longer
   queued/sending; the board aborts, closes the connection (Receive drops its temp file) and refetches the queue.
   *Task 2 (409) and Task 4 (abort on a failed chunk).*
4. **An old board (1.13.x) polls the new server** and must see byte-for-byte the response it saw before: no `xfer`
   key, no new wake. *Task 3.*
5. **A queue whose paths are long and Latin-1** must keep the `SEND_QUEUE_BYTES` budget (trailing LIST entries
   dropped, never a cut line) and correct byte lengths for é. *Task 1.*

---

## File structure

```
src/db/schema/transfers.ts            the transfers table (+ export from the schema index)
src/db/schema/devices.ts              + send_version, send_rx, send_rx_at
drizzle/0040_transfers.sql            generated (pnpm db:generate --name transfers)
src/lib/transfers.ts                  XFER_FW, limits, cleanAmigaPath, queueTransferFromBlob, sendQueueText,
                                      recordChunk, finishTransfer, cancelTransfer, expireTransfers, recordSendRx
src/lib/transfers.test.ts             pure tests (cleanAmigaPath, queue text budget)
src/lib/transfers.db.test.ts          db tests
src/lib/storage/backend.ts, local.ts, vercel-blob.ts, index.ts   + getRange / diskStore.readRange
src/app/api/device/send/queue/route.ts         GET: the protocol text
src/app/api/device/send/[id]/route.ts          GET ?offset&length: bytes (records progress)
src/app/api/device/send/[id]/done/route.ts     POST: the outcome
src/app/api/cron/transfers/route.ts             daily expiry
src/app/api/device/poll/route.ts, src/lib/mount.ts   xfer cursor, wake, rx
src/lib/blob-gc-run.ts                + transfers.blob_sha256
vercel.ts                             + the cron
scripts/send-to-amiga.ts              bench tool: put a local file in the store and queue it for a board
wifi-floppy/firmware/src/amiga_send.h/.c       pure state machine (host-tested)
wifi-floppy/firmware/test/test_amiga_send.c
wifi-floppy/firmware/src/device_client.h/.c    dc_fetch_send_queue, dc_fetch_send_chunk, dc_post_send_done,
                                               xferAck/rx in the poll, dc_take_xfer
wifi-floppy/firmware/test/test_device_client.c + cases
wifi-floppy/firmware/src/amiga_tcp.h/.c        lwIP raw TCP client (device-only; excluded in test/run.sh)
wifi-floppy/firmware/src/main.c                core1 wiring
wifi-floppy/firmware/CMakeLists.txt            FIRMWARE_SEMVER 1.14.0
```

---

### Task 1: The transfers table and the queue library

**Files:**
- Create: `src/db/schema/transfers.ts`; Modify: `src/db/schema/devices.ts`, the schema index that re-exports tables
  (find it with `grep -rn "export \* from './devices'" src/db/schema`)
- Generate: `drizzle/0040_transfers.sql` (+ journal, snapshot)
- Create: `src/lib/transfers.ts`, `src/lib/transfers.test.ts`, `src/lib/transfers.db.test.ts`

**Interfaces:**
- Produces (exact):

```ts
export const XFER_FW = '1.14.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const SEND_QUEUE_BYTES = 6144;          // the queue text's budget (firmware buffer)
export const SEND_CHUNK_MAX = 16_384;
export const SEND_EXPIRE_MS = 24 * 3600_000;
export const SEND_KEEP_FINISHED_MS = 7 * 24 * 3600_000;
export type TransferStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired';
export function cleanAmigaPath(input: string): string | null;
export function latin1Len(s: string): number;
export type QueueResult = { ok: true; id: string } | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device' | 'no_blob' };
export async function queueTransferFromBlob(db: Db, a: { orgId: string; deviceId: string; userId: string; path: string;
  sha256: string; protection?: number; comment?: string; now?: Date }): Promise<QueueResult>;
export async function sendQueueText(db: Db, deviceId: string, now?: Date): Promise<string>;
export function formatQueue(next: QueueRow | null, rows: QueueRow[]): string;   // pure, budgeted
export type QueueRow = { id: string; sizeBytes: number; crc32: number; protection: number; path: string; comment: string };
export async function recordChunk(db: Db, deviceId: string, id: string, offset: number):
  Promise<{ ok: true; sha256: string; sizeBytes: number } | { ok: false; status: 404 | 409 }>;
export type SendOutcome = { ok: true; savedAs: string } | { ok: false; code: string; text: string };
export async function finishTransfer(db: Db, deviceId: string, id: string, o: SendOutcome, now?: Date): Promise<boolean>;
export async function cancelTransfer(db: Db, orgId: string, id: string): Promise<boolean>;
export async function expireTransfers(db: Db, now?: Date): Promise<{ expired: number; deleted: number }>;
export async function recordSendRx(db: Db, deviceId: string, rx: 'c' | 'r' | 'u' | '-', now?: Date): Promise<void>;
```

`Db` is the drizzle type the other libs use (`import type { Db } from '@/db'`, or whatever `firmware-import.ts` imports;
use the same).

**Rules (each is tested):**
- **`cleanAmigaPath`:**
  - splits on `/`, drops empty, `.` and `..` parts;
  - per part: `:` becomes `_`; control characters are removed; a character outside Latin-1 becomes `_`;
  - a part is cut to 30 Latin-1 bytes, keeping its extension when the extension is 1-8 characters;
  - joins with `/`; the result must be 1..255 characters, else `null`.

  So `"../evil/Café.LHA"` → `"evil/Café.LHA"`, and `"a:b"` → `"a_b"`.
- **`queueTransferFromBlob`:**
  - the device must exist with `org_id = orgId` (`no_device`);
  - `diskStore.stat` gives the size, ≤ 4 MB (`too_large`), else `no_blob`;
  - the CRC-32 comes from `zlib.crc32(await diskStore.read(sha))`;
  - the board's queued + sending rows must stay ≤ 32 and ≤ 16 MB after adding (`queue_full`);
  - it inserts with `expires_at = now + 24 h` and bumps `devices.send_version` (`+1`) in the same transaction.
- **`formatQueue`:**
  - line 1 is `NEXT <id> <size> <crc hex> <prot hex> <len>:<path> <len>:<comment>`, or `NEXT -`;
  - then `LIST <n>` and n lines `<id> <size> <len>:<path>`, oldest first;
  - all lengths are Latin-1 byte lengths;
  - if the text would exceed `SEND_QUEUE_BYTES`, trailing LIST lines are dropped and `n` matches the lines kept.
- **`sendQueueText`:** NEXT is the oldest row in `sending` or `queued` with `expires_at > now`; LIST is every such row,
  including NEXT.
- **`recordChunk`:**
  - a row that is not this device's → 404; status not queued/sending → 409;
  - otherwise it sets `status = 'sending'`, `bytes_sent = offset`.
- **`finishTransfer`:**
  - only from queued/sending;
  - `ok` → `delivered`, `saved_as`; else `failed`, `error_code`, `error_text` (text cut to 120 characters);
  - sets `finished_at` and bumps `send_version`.
- **`cancelTransfer`:** queued/sending → `cancelled`, bumps `send_version`.
- **`expireTransfers`:** queued rows past `expires_at` → `expired` (with a bump per device); rows finished more than
  7 days ago are deleted.
- **`recordSendRx`:** writes `send_rx` and `send_rx_at` only when `rx` differs from the stored value or `send_rx_at`
  is older than 30 s, so a poll every 25 s does not write every time.

- [ ] **Step 1: Worktree**

```bash
cd /Users/sfs/Devel/webadf
git worktree add .claude/worktrees/send -b feat/send-board master
cd .claude/worktrees/send && pnpm install --offline && cp ../../../.env.local . && pnpm next typegen
```

(Memory: worktree e2e needs a real install, `.env.local` and `next typegen`. Never print `.env.local`.)

- [ ] **Step 2: Schema**

`src/db/schema/transfers.ts`:

```ts
import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { devices } from './devices';

// Files sent from the web app to a board's Amiga (PaulaNET Phase 4, spec 2026-10-16 §4).
export const transfers = pgTable('transfers', {
  id: text('id').primaryKey(),                                   // crypto.randomUUID()
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').notNull(),
  path: text('path').notNull(),                                  // cleaned, Latin-1 only
  sizeBytes: integer('size_bytes').notNull(),
  crc32: bigint('crc32', { mode: 'number' }).notNull(),
  protection: bigint('protection', { mode: 'number' }).notNull().default(0),
  comment: text('comment').notNull().default(''),
  blobSha256: text('blob_sha256').notNull(),
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  errorText: text('error_text'),
  savedAs: text('saved_as'),
  bytesSent: integer('bytes_sent').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('transfers_device_idx').on(t.deviceId, t.status, t.createdAt)]);
```

Before typing it, check `devices.ts` for the timestamp style the repo uses (`withTimezone`, `mode`), and match it.

In `devices.ts`, next to the `net*` columns:

```ts
  // Phase 4: bumped on every queue change for this board (the poll's `xfer.v`); the receiver state from `rx=`.
  sendVersion: integer('send_version').notNull().default(0),
  sendRx: text('send_rx'),
  sendRxAt: timestamp('send_rx_at', { withTimezone: true }),
```

Re-export `transfers` from the schema index.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate --name transfers`. Expected: `drizzle/0040_transfers.sql` with `CREATE TABLE "transfers"`, the
foreign key, the index, and three `ALTER TABLE "devices" ADD COLUMN` statements. Read the SQL and check that it is
additive only (no drops, no rewrites).

- [ ] **Step 4: Write the failing pure tests**

`src/lib/transfers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cleanAmigaPath, formatQueue, latin1Len, SEND_QUEUE_BYTES, type QueueRow } from './transfers';

describe('cleanAmigaPath', () => {
  it('keeps a plain name and folders', () => {
    expect(cleanAmigaPath('Hello.txt')).toBe('Hello.txt');
    expect(cleanAmigaPath('mods/axelf.mod')).toBe('mods/axelf.mod');
  });
  it('drops parent and empty parts, never escaping the folder', () => {
    expect(cleanAmigaPath('../evil/Café.LHA')).toBe('evil/Café.LHA');
    expect(cleanAmigaPath('/abs//x/./y')).toBe('abs/x/y');
    expect(cleanAmigaPath('../..')).toBeNull();
  });
  it('replaces colons and non-Latin-1, removes control characters', () => {
    expect(cleanAmigaPath('DH0:x')).toBe('DH0_x');
    expect(cleanAmigaPath('日本.txt')).toBe('__.txt');
    expect(cleanAmigaPath('a\u0007b')).toBe('ab');
  });
  it('cuts a part to 30 bytes and keeps a short extension', () => {
    expect(cleanAmigaPath('A'.repeat(40) + '.lha')).toBe('A'.repeat(26) + '.lha');
    expect(cleanAmigaPath('B'.repeat(40))).toBe('B'.repeat(30));
  });
  it('refuses a result over 255 bytes', () => {
    expect(cleanAmigaPath(Array.from({ length: 10 }, () => 'C'.repeat(30)).join('/'))).toBeNull();
  });
});

const row = (i: number, path = `File${i}.bin`): QueueRow =>
  ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sizeBytes: 1000 + i, crc32: 0xcbf43926, protection: 0x40, path, comment: '' });

describe('formatQueue', () => {
  it('writes NEXT and LIST in the protocol form', () => {
    const r = row(1, 'Café.txt');
    const t = formatQueue(r, [r]);
    expect(t).toBe(`NEXT ${r.id} 1001 cbf43926 40 8:Café.txt 0:\nLIST 1\n${r.id} 1001 8:Café.txt\n`);
    expect(latin1Len('Café.txt')).toBe(8);
  });
  it('says NEXT - with an empty list', () => {
    expect(formatQueue(null, [])).toBe('NEXT -\nLIST 0\n');
  });
  it('drops trailing LIST lines to stay in budget, never cutting a line', () => {
    const rows = Array.from({ length: 32 }, (_, i) => row(i, 'D'.repeat(30) + '/' + 'E'.repeat(30) + '/' + 'F'.repeat(30) + '/' + 'G'.repeat(30) + '/' + 'H'.repeat(30) + '/' + 'I'.repeat(30) + '/' + 'J'.repeat(30) + '/' + `n${i}`));
    const t = formatQueue(rows[0], rows);
    expect(Buffer.byteLength(t, 'latin1')).toBeLessThanOrEqual(SEND_QUEUE_BYTES);
    const n = Number(/\nLIST (\d+)\n/.exec(t)![1]);
    expect(n).toBeLessThan(32);
    expect(t.trimEnd().split('\n').length).toBe(2 + n);
  });
});
```

Run: `pnpm vitest run src/lib/transfers.test.ts`. Expected: FAIL, cannot resolve `./transfers`.

- [ ] **Step 5: Write the failing db tests**

`src/lib/transfers.db.test.ts` follows `src/lib/firmware-import.db.test.ts:12-33` for setup: its own database
`webadf_transfers_test`, `STORAGE_DIR` in a mkdtemp folder, `BLOB_READ_WRITE_TOKEN = ''`, migrate, and dynamic imports.
It seeds one org's device row with the minimal insert the other db tests use (copy their helper). It puts blobs with
`diskStore.put(sha, bytes)`.

Cases, each one `it`:
1. Queueing a 5-byte blob gives `ok`. The row's `crc32` = `zlib.crc32(bytes)` and its `size_bytes` = 5;
   `devices.send_version` goes 0 → 1.
2. A wrong org gives `no_device`; an unknown sha gives `no_blob`; a 4 MB + 1 blob gives `too_large`.
3. A 33rd file gives `queue_full`; so does going past 16 MB with five 4 MB blobs (the fifth refused).
4. `sendQueueText`: the oldest queued row is NEXT. After `recordChunk(… offset 0)` makes it `sending`, it is still NEXT.
   An expired row (`now` past `expires_at`) is in neither NEXT nor LIST.
5. `recordChunk`: a row from another device → 404; a cancelled row → 409; otherwise `bytes_sent` = offset.
6. `finishTransfer` ok → `delivered` with `saved_as`, and the version bumps. A second finish → `false` (row unchanged).
   A failure stores the code and the text cut to 120 characters.
7. `cancelTransfer` from queued → `cancelled` + bump; from delivered → `false`.
8. `expireTransfers(now + 25 h)` marks queued as expired. With `now + 8 days`, it deletes finished rows and returns
   counts.
9. `recordSendRx`: the same value within 30 s does not write (`send_rx_at` unchanged); a new value writes.

Run: `pnpm db:dev start` (once), then `TEST_DATABASE_URL=… pnpm test:db src/lib/transfers.db.test.ts`; use the URL
`pnpm db:dev start` prints. Expected: FAIL, missing module.

- [ ] **Step 6: Implement `src/lib/transfers.ts`**

```ts
import { crc32 } from 'node:zlib';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { devices, transfers } from '@/db/schema';
import { diskStore } from '@/lib/storage';
import type { Db } from '@/db';

export const XFER_FW = '1.14.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const SEND_QUEUE_BYTES = 6144;
export const SEND_CHUNK_MAX = 16_384;
export const SEND_EXPIRE_MS = 24 * 3600_000;
export const SEND_KEEP_FINISHED_MS = 7 * 24 * 3600_000;
export type TransferStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired';
const ACTIVE: TransferStatus[] = ['queued', 'sending'];

export const latin1Len = (s: string) => Buffer.byteLength(s, 'latin1');

/** An Amiga-safe relative path (spec §2): Latin-1, parts of 1..30 bytes, no ':' '.' '..', at most 255 bytes. */
export function cleanAmigaPath(input: string): string | null {
  const parts: string[] = [];
  for (const raw of input.split('/')) {
    let p = '';
    for (const ch of raw) {
      const c = ch.codePointAt(0)!;
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
      p += ch === ':' ? '_' : c > 0xff ? '_' : ch;
    }
    if (p === '' || p === '.' || p === '..') continue;
    if (p.length > 30) {
      const dot = p.lastIndexOf('.');
      const ext = dot > 0 && p.length - dot <= 9 ? p.slice(dot) : '';
      p = p.slice(0, 30 - ext.length) + ext;
    }
    parts.push(p);
  }
  const out = parts.join('/');
  return out.length >= 1 && out.length <= 255 ? out : null;
}

export type QueueRow = { id: string; sizeBytes: number; crc32: number; protection: number; path: string; comment: string };

export function formatQueue(next: QueueRow | null, rows: QueueRow[]): string {
  const head = next
    ? `NEXT ${next.id} ${next.sizeBytes} ${next.crc32.toString(16)} ${next.protection.toString(16)} ` +
      `${latin1Len(next.path)}:${next.path} ${latin1Len(next.comment)}:${next.comment}\n`
    : 'NEXT -\n';
  const lines = rows.map((r) => `${r.id} ${r.sizeBytes} ${latin1Len(r.path)}:${r.path}\n`);
  for (let n = lines.length; n >= 0; n--) {
    const t = head + `LIST ${n}\n` + lines.slice(0, n).join('');
    if (latin1Len(t) <= SEND_QUEUE_BYTES) return t;
  }
  return head + 'LIST 0\n';
}

export type QueueResult = { ok: true; id: string } | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device' | 'no_blob' };

export async function queueTransferFromBlob(db: Db, a: { orgId: string; deviceId: string; userId: string; path: string;
  sha256: string; protection?: number; comment?: string; now?: Date }): Promise<QueueResult> {
  const path = cleanAmigaPath(a.path);
  if (!path) return { ok: false, reason: 'bad_name' };
  const [dev] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, a.deviceId), eq(devices.orgId, a.orgId)));
  if (!dev) return { ok: false, reason: 'no_device' };
  const st = await diskStore.stat(a.sha256);
  if (!st) return { ok: false, reason: 'no_blob' };
  if (st.sizeBytes > SEND_FILE_MAX) return { ok: false, reason: 'too_large' };
  const bytes = await diskStore.read(a.sha256);
  const crc = crc32(bytes) >>> 0;
  const now = a.now ?? new Date();
  const comment = (a.comment ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);
  return db.transaction(async (tx) => {
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<number>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
      .from(transfers).where(and(eq(transfers.deviceId, a.deviceId), inArray(transfers.status, ACTIVE)));
    if (load.n + 1 > SEND_QUEUE_MAX_FILES || Number(load.b) + st.sizeBytes > SEND_QUEUE_MAX_BYTES)
      return { ok: false as const, reason: 'queue_full' as const };
    const id = crypto.randomUUID();
    await tx.insert(transfers).values({ id, orgId: a.orgId, deviceId: a.deviceId, createdByUserId: a.userId, path,
      sizeBytes: st.sizeBytes, crc32: crc, protection: (a.protection ?? 0) >>> 0, comment, blobSha256: a.sha256,
      expiresAt: new Date(now.getTime() + SEND_EXPIRE_MS) });
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return { ok: true as const, id };
  });
}

export async function sendQueueText(db: Db, deviceId: string, now = new Date()): Promise<string> {
  const rows = await db.select({ id: transfers.id, sizeBytes: transfers.sizeBytes, crc32: transfers.crc32,
    protection: transfers.protection, path: transfers.path, comment: transfers.comment })
    .from(transfers)
    .where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  return formatQueue(rows[0] ?? null, rows);
}

export async function recordChunk(db: Db, deviceId: string, id: string, offset: number):
  Promise<{ ok: true; sha256: string; sizeBytes: number } | { ok: false; status: 404 | 409 }> {
  const [r] = await db.select({ status: transfers.status, sha: transfers.blobSha256, size: transfers.sizeBytes })
    .from(transfers).where(and(eq(transfers.id, id), eq(transfers.deviceId, deviceId)));
  if (!r) return { ok: false, status: 404 };
  if (!ACTIVE.includes(r.status as TransferStatus)) return { ok: false, status: 409 };
  await db.update(transfers).set({ status: 'sending', bytesSent: offset }).where(eq(transfers.id, id));
  return { ok: true, sha256: r.sha, sizeBytes: r.size };
}

export type SendOutcome = { ok: true; savedAs: string } | { ok: false; code: string; text: string };

export async function finishTransfer(db: Db, deviceId: string, id: string, o: SendOutcome, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(transfers).set(o.ok
      ? { status: 'delivered', savedAs: o.savedAs.slice(0, 255), finishedAt: now }
      : { status: 'failed', errorCode: o.code.slice(0, 16), errorText: o.text.slice(0, 120), finishedAt: now })
      .where(and(eq(transfers.id, id), eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE)))
      .returning({ id: transfers.id });
    if (done.length === 0) return false;
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, deviceId));
    return true;
  });
}

export async function cancelTransfer(db: Db, orgId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(transfers).set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(transfers.id, id), eq(transfers.orgId, orgId), inArray(transfers.status, ACTIVE)))
      .returning({ deviceId: transfers.deviceId });
    if (done.length === 0) return false;
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, done[0].deviceId));
    return true;
  });
}

export async function expireTransfers(db: Db, now = new Date()): Promise<{ expired: number; deleted: number }> {
  return db.transaction(async (tx) => {
    const ex = await tx.update(transfers).set({ status: 'expired', finishedAt: now })
      .where(and(eq(transfers.status, 'queued'), lt(transfers.expiresAt, now)))
      .returning({ deviceId: transfers.deviceId });
    const devs = [...new Set(ex.map((e) => e.deviceId))];
    if (devs.length) await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(inArray(devices.id, devs));
    const del = await tx.delete(transfers)
      .where(lt(transfers.finishedAt, new Date(now.getTime() - SEND_KEEP_FINISHED_MS))).returning({ id: transfers.id });
    return { expired: ex.length, deleted: del.length };
  });
}

export async function recordSendRx(db: Db, deviceId: string, rx: 'c' | 'r' | 'u' | '-', now = new Date()): Promise<void> {
  await db.update(devices).set({ sendRx: rx, sendRxAt: now }).where(and(eq(devices.id, deviceId),
    sql`(${devices.sendRx} is distinct from ${rx} or ${devices.sendRxAt} is null or ${devices.sendRxAt} < ${new Date(now.getTime() - 30_000)})`));
}
```

If `Db` or `diskStore` import names differ, use the repo's names (record the change as a ruling in the ledger).
`crypto.randomUUID` is global in Node 24.

- [ ] **Step 7: Run both test files to watch them pass**

Run: `pnpm vitest run src/lib/transfers.test.ts` and the db test from Step 5. Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema drizzle src/lib/transfers.ts src/lib/transfers.test.ts src/lib/transfers.db.test.ts
git commit -m "send: transfers table (migration 0040) and the queue library -- limits, Amiga-safe names, queue text, outcomes, expiry"
```

---

### Task 2: Ranged blob reads, the three device routes, blob GC

**Files:**
- Modify: `src/lib/storage/backend.ts` (`getRange`), `local.ts`, `vercel-blob.ts`, `index.ts` (`diskStore.readRange`)
- Create: `src/app/api/device/send/queue/route.ts`, `src/app/api/device/send/[id]/route.ts`,
  `src/app/api/device/send/[id]/done/route.ts`, and a `route.test.ts` beside each
- Modify: `src/lib/blob-gc-run.ts` (+ its test)

**Interfaces:**
- Consumes: Task 1's `sendQueueText`, `recordChunk`, `finishTransfer` and `SEND_CHUNK_MAX`; `requireDevice` and
  `deviceAuthResponse` (`src/lib/device-auth.ts`).
- Produces:
  - `BlobBackend.getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>`;
  - `diskStore.readRange(sha256: string, offset: number, length: number): Promise<Uint8Array>`;
  - **`GET /api/device/send/queue`** → 200 `text/plain; charset=iso-8859-1`; the body is Task 1's queue text as
    Latin-1 bytes; `cache-control: no-store`.
  - **`GET /api/device/send/<id>?offset=<o>&length=<n>`** → 200 `application/octet-stream`, exactly
    `min(n, size - o)` bytes. It answers:
    - 400 if `o` or `n` is not a non-negative integer, `n` is 0 or more than 16384, or `o` ≥ the size (an empty file
      is never fetched);
    - 404 if the row is not this device's;
    - 409 if the row is no longer queued/sending.
  - **`POST /api/device/send/<id>/done`** with body `{"ok":true,"savedAs":"…"}` or
    `{"ok":false,"code":"…","text":"…"}` → 204; 400 for a bad body; 409 if already finished (the board then simply
    refetches).

- [ ] **Step 1: Failing backend test**

In the existing storage test for the local backend (find it with `ls src/lib/storage/*.test.ts`), add:

```ts
it('reads a byte range', async () => {
  const b = backendUnderTest();                 // whatever the file uses to build the local backend
  await b.put('adf/' + 'a'.repeat(64), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { contentType: 'application/octet-stream', overwrite: false });
  expect([...(await b.getRange('adf/' + 'a'.repeat(64), 3, 6))!]).toEqual([3, 4, 5, 6]);
  expect([...(await b.getRange('adf/' + 'a'.repeat(64), 8, 20))!]).toEqual([8, 9]);   // clamped at the end
  expect(await b.getRange('adf/' + 'b'.repeat(64), 0, 1)).toBeNull();
});
```

Run it. Expected: FAIL, `getRange is not a function`.

- [ ] **Step 2: Implement `getRange`**

`backend.ts`, in the `BlobBackend` interface:

```ts
  /** Bytes start..endInclusive (clamped to the object's end), or null if the object does not exist. */
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>;
```

`local.ts`: open the file with `fs.promises.open`, `stat` it, clamp `endInclusive` to `size - 1`, `read` into a buffer
of that length at `start`, close it; `ENOENT` → `null`. Call `assertKey(key)` first, like the other methods.

`vercel-blob.ts`:

```ts
    async getRange(key, start, endInclusive) {
      assertKey(key);
      const r = await get(key, { access: 'private', useCache: false, headers: { range: `bytes=${start}-${endInclusive}` } });
      if (!r) return null;
      const all = new Uint8Array(await new Response(r.stream).arrayBuffer());
      // A store that ignores Range answers with the whole object: slice it ourselves.
      const ranged = r.headers.get('content-range') !== null || all.length <= endInclusive - start + 1;
      return ranged ? all : all.subarray(start, Math.min(endInclusive + 1, all.length));
    }
```

Check how the existing `get` maps "not found" (null, or a thrown `BlobNotFoundError`?) and do the same. Check the
`get` return field names in `node_modules/@vercel/blob/dist/index.d.ts` (`GetBlobResult` around line 175: `stream`,
`headers`) and adapt them if they differ.

`index.ts`, in `diskStore`:

```ts
  async readRange(sha256: string, offset: number, length: number): Promise<Uint8Array> {
    assertSha(sha256);
    const b = await backend().getRange(this.storageKey(sha256), offset, offset + length - 1);
    if (!b) throw new Error(`disk blob ${sha256} not found`);
    return b;
  },
```

(Match how `read` builds its key and throws.) Run the backend test. Expected: PASS.

- [ ] **Step 3: Failing route tests**

Model each on `src/app/api/device/poll/route.test.ts`: `vi.mock('@/lib/device-auth')` with `requireDevice` resolving
`{ deviceId: 'd1', orgId: 'o1' }`, and `vi.mock('@/lib/transfers')` / `vi.mock('@/lib/storage')`.

- **queue:**
  - the body is `Buffer.from('NEXT -\nLIST 0\n','latin1')`, with the content-type and `no-store` headers;
  - with a mocked text containing `Café`, the response bytes contain `0xE9`.
- **chunk:**
  - `offset=0&length=16384` on a 20,000-byte row → 16,384 bytes, and `recordChunk` was called with offset 0;
  - `offset=16384&length=16384` → 3,616 bytes;
  - `length=16385` → 400; `offset=-1` → 400; `offset=20000` → 400;
  - `recordChunk` returning `{ok:false,status:409}` → 409.
- **done:**
  - an ok body → 204, with `finishTransfer` called with `{ok:true,savedAs}`;
  - a failed body → 204;
  - `{}` → 400; `finishTransfer` returning false → 409.

Expected: FAIL, missing route modules.

- [ ] **Step 4: Implement the routes**

`src/app/api/device/send/queue/route.ts`:

```ts
import { getDb } from '@/db';
import { deviceAuthResponse, requireDevice } from '@/lib/device-auth';
import { sendQueueText } from '@/lib/transfers';

export async function GET(request: Request) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const r = deviceAuthResponse(e); if (r) return r; throw e; }
  const text = await sendQueueText(getDb(), device.deviceId);
  return new Response(Buffer.from(text, 'latin1'), {
    headers: { 'content-type': 'text/plain; charset=iso-8859-1', 'cache-control': 'no-store' },
  });
}
```

`src/app/api/device/send/[id]/route.ts`:

```ts
import { getDb } from '@/db';
import { deviceAuthResponse, requireDevice } from '@/lib/device-auth';
import { diskStore } from '@/lib/storage';
import { recordChunk, SEND_CHUNK_MAX } from '@/lib/transfers';

export const maxDuration = 60;
const int = (v: string | null) => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null);

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const r = deviceAuthResponse(e); if (r) return r; throw e; }
  const { id } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const offset = int(q.get('offset')), length = int(q.get('length'));
  if (offset === null || length === null || length === 0 || length > SEND_CHUNK_MAX) return new Response('bad range', { status: 400 });
  const r = await recordChunk(getDb(), device.deviceId, id, offset);
  if (!r.ok) return new Response(null, { status: r.status });
  if (offset >= r.sizeBytes) return new Response('bad range', { status: 400 });
  const bytes = await diskStore.readRange(r.sha256, offset, Math.min(length, r.sizeBytes - offset));
  return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}
```

Check how this repo types route `params` in Next's current version: read
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, or copy the signature from
`src/app/api/device/image/[sha256]/route.ts`.

`src/app/api/device/send/[id]/done/route.ts`:

```ts
import { z } from 'zod';
import { getDb } from '@/db';
import { deviceAuthResponse, requireDevice } from '@/lib/device-auth';
import { finishTransfer } from '@/lib/transfers';

const body = z.union([
  z.object({ ok: z.literal(true), savedAs: z.string().min(1).max(255) }),
  z.object({ ok: z.literal(false), code: z.string().min(1).max(16), text: z.string().max(200) }),
]);

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const r = deviceAuthResponse(e); if (r) return r; throw e; }
  const { id } = await ctx.params;
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const done = await finishTransfer(getDb(), device.deviceId, id, p.data);
  return new Response(null, { status: done ? 204 : 409 });
}
```

Run the three route tests. Expected: PASS.

- [ ] **Step 5: Blob GC reference** (memory: a new sha column must join `runBlobGc`'s list)

Add a failing case to `src/lib/blob-gc-run.test.ts` (or its db test, whichever builds the reference list against
rows): a blob referenced only by a `transfers` row is not collected. Run it and watch it fail. Then add to the
list at `src/lib/blob-gc-run.ts:40-55`:

```ts
    db.selectDistinct({ s: transfers.blobSha256 }).from(transfers),
```

and add that query's results to `referenced`, the way the others are. Run the test. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage src/app/api/device/send src/lib/blob-gc-run.ts src/lib/blob-gc-run*.test.ts
git commit -m "send: device routes for the queue text, file chunks (offset = progress) and outcomes; ranged blob reads; GC keeps queued files"
```

---

### Task 3: The poll's `xfer` cursor, the receiver state, the expiry cron, a bench tool

**Files:**
- Modify: `src/lib/mount.ts` (`PollTick` and `readPollTick` select `sendVersion`), `src/app/api/device/poll/route.ts`
  (+ `route.test.ts`)
- Create: `src/app/api/cron/transfers/route.ts` (+ test); Modify: `vercel.ts`
- Create: `scripts/send-to-amiga.ts`

**Interfaces:**
- Consumes: `recordSendRx` and `expireTransfers` (Task 1).
- Produces (the poll; the board reads these):
  - **Request:** `&xferAck=<v>&rx=<c|r|u|->`. `xferAck` present means the board can send; `rx` is the receiver state.
  - **Wake:** when `xferAck !== null && tick.sendVersion !== xferAck`.
  - **Response:** `xfer: { v: <sendVersion> }`, only when `xferAck` was sent. It adds at most 20 bytes, under
    `DC_POLL_BODY_BYTES`; check with `src/lib/device-limits.test.ts`'s worst case and extend that test with `xfer`.

- [ ] **Step 1: Failing poll tests** (in `src/app/api/device/poll/route.test.ts`; `baseTick` gets `sendVersion: 0`)
  1. Without `xferAck`, the body has no `xfer` key and `recordSendRx` is not called. This guards old boards, Review
     Focus 4.
  2. `xferAck=0`, with tick `sendVersion` 3 → wakes on the first tick; `body.xfer` = `{ v: 3 }`.
  3. `xferAck=3`, `sendVersion` 3, with another wake reason present (copy an existing case's wake) → `xfer.v` = 3.
  4. `rx=c` → `recordSendRx(…, 'd1', 'c')` called once; `rx=zz` → not called.

  `vi.mock('@/lib/transfers')` for `recordSendRx`. Expected: FAIL.

- [ ] **Step 2: Implement in the poll route and `mount.ts`**
  - `PollTick` gets `sendVersion: number`, and `readPollTick` selects `devices.sendVersion`.
  - In the route, next to `df1Ack`, parse `xferAck` with the same integer rule and `rx` with `/^[cru-]$/`. Call
    `recordSendRx(getDb(), device.deviceId, rx)` once before the hold loop when both are present.
  - Add `xferWake = xferAck !== null && tick.sendVersion !== xferAck` to the wake condition at `:187`.
  - Put `...(xferAck !== null ? { xfer: { v: tick.sendVersion } } : {})` in the response object.

  Run the poll tests plus `src/lib/device-limits.test.ts`. Expected: PASS.

- [ ] **Step 3: The cron.** `src/app/api/cron/transfers/route.ts` copies the inline CRON_SECRET check from
  `src/app/api/cron/blob-gc/route.ts`. It then calls `expireTransfers(getDb())`, logs
  `transfers: expired N, deleted M`, and returns the JSON counts. Its test, modelled on the blob-gc route test:
  - no or wrong bearer → 401;
  - the right one → 200 with the counts (mock `expireTransfers`).

  Add `{ path: '/api/cron/transfers', schedule: '45 3 * * *' }` to `vercel.ts`. It uses plain numbers only, as
  `parseCron` requires; the self-host scheduler picks it up from `vercel.ts`.

- [ ] **Step 4: Bench tool** `scripts/send-to-amiga.ts`:

```ts
// Bench tool (Phase 4): put a local file in the disk store and queue it for a board.
// Usage: pnpm tsx scripts/send-to-amiga.ts <deviceId> <file> [amigaPath]   (DATABASE_URL and storage from the env)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema';
import { diskStore } from '@/lib/storage';
import { queueTransferFromBlob } from '@/lib/transfers';

const [deviceId, file, amigaPath] = process.argv.slice(2);
if (!deviceId || !file) { console.error('usage: send-to-amiga <deviceId> <file> [amigaPath]'); process.exit(2); }
const bytes = new Uint8Array(readFileSync(file));
const sha = createHash('sha256').update(bytes).digest('hex');
if (!(await diskStore.stat(sha))) await diskStore.put(sha, bytes);
const db = getDb();
const [d] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId));
if (!d) { console.error('no such device'); process.exit(1); }
const r = await queueTransferFromBlob(db, { orgId: d.orgId, deviceId, userId: 'bench', path: amigaPath ?? basename(file), sha256: sha });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
```

Copy how other scripts load `.env.local` (`grep -n "dotenv" package.json`) and run them the same way, e.g.
`dotenv -e .env.local -- tsx …`. Add the script `"send:queue": "dotenv -e .env.local -- tsx scripts/send-to-amiga.ts"`.
Against production, this script writes a production row and blob: it is run only in Task 7, with the operator's yes.

- [ ] **Step 5: Server checks**

Run: `pnpm test > /tmp/send-vitest.log 2>&1; tail -5 /tmp/send-vitest.log`, the db tests, and `pnpm exec tsc --noEmit`.
Expected: all pass, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mount.ts src/app/api/device/poll src/app/api/cron/transfers vercel.ts scripts/send-to-amiga.ts package.json src/lib/device-limits.test.ts
git commit -m "send: the poll carries xfer.v and wakes on a queue change; rx= records the receiver state; daily expiry cron; bench queue tool"
```

---

### Task 4: `amiga_send`, the board's state machine (pure, host-tested)

**Files:**
- Create: `wifi-floppy/firmware/src/amiga_send.h`, `wifi-floppy/firmware/src/amiga_send.c`,
  `wifi-floppy/firmware/test/test_amiga_send.c`

**Interfaces:**
- Produces (exact; Task 6 wires them):

```c
#define AS_PORT 6800
#define AS_QUEUE_BYTES 6144            /* = the server's SEND_QUEUE_BYTES */
#define AS_CHUNK_BYTES 16384
#define AS_LINE_MAX 320
enum { AS_SOCK_CLOSED, AS_SOCK_CONNECTING, AS_SOCK_OPEN, AS_SOCK_REFUSED };
typedef struct as_ops {
    void *ctx;
    int  (*connect)(void *ctx, uint32_t ip_host_order, uint16_t port);  /* 0 = started */
    int  (*sock_state)(void *ctx);                                       /* AS_SOCK_* */
    int  (*send)(void *ctx, const uint8_t *b, int n);    /* bytes accepted now (0..n), <0 = broken */
    int  (*recv_line)(void *ctx, char *out, int cap);    /* 1 = a line (no LF), 0 = none yet, <0 = closed */
    void (*close)(void *ctx);
    int  (*fetch_queue)(void *ctx, char *buf, int cap);  /* body length, <0 = failed */
    int  (*fetch_chunk)(void *ctx, const char *id, uint32_t off, uint32_t len, uint8_t *buf); /* bytes, or -http status / -1 */
    int  (*post_done)(void *ctx, const char *id, const char *json);     /* http status, <0 = failed */
    uint32_t (*now_ms)(void *ctx);
} as_ops_t;
typedef struct amiga_send amiga_send_t;  /* defined in the header; fields private by convention */
void as_init(amiga_send_t *s, const as_ops_t *ops);
void as_set_inputs(amiga_send_t *s, bool net_on, uint32_t amiga_ip, uint32_t queue_version);
void as_tick(amiga_send_t *s);          /* cheap; every core1 pass: connect retries, pings, line reads */
bool as_has_work(const amiga_send_t *s);/* a file is moving or the queue must be fetched: skip the long poll */
void as_step(amiga_send_t *s);          /* one bounded unit of work (one HTTPS exchange at most) */
char as_rx(const amiga_send_t *s);      /* 'c' connected, 'r' refused, 'u' unreachable, '-' unknown/off */
uint32_t as_acked_version(const amiga_send_t *s);  /* the queue version last fetched: the poll's xferAck */
```

**Behaviour (each line is a test):**
- **Off or no address:** with `net_on` false or `amiga_ip` 0, it closes any socket, `as_rx` = `'-'`, and there is no
  work.
- **Connecting:**
  - with net on and an address, `as_tick` connects when closed; it retries after 5 s if a file is waiting
    (`NEXT` ≠ `-`), else after 30 s;
  - a refusal gives `'r'`; a connect not open within 10 s gives `'u'`.
- **Handshake on open:** send `WEBADF 1\n`, expect `READY 1` within 10 s, else close and set `'u'`. Then `'c'`.
- **The queue:**
  - when `queue_version` ≠ the version last fetched, `as_has_work` is true and `as_step` calls `fetch_queue`;
  - on success it stores the text and the version;
  - on open, and after every fetch while open, it forwards the `LIST` block (everything after line 1) unchanged.
- **One file** (`NEXT <id> <size> …`), while open:
  1. Send `FILE` + line 1 minus the `NEXT ` prefix, plus LF, and wait for `GO <id>` or `ERR <id> …`, up to 30 s.
  2. On `ERR`: `post_done(id, {"ok":false,"code":…,"text":…})`, then refetch.
  3. On `GO`, one `as_step` per chunk: `fetch_chunk(id, off, min(16384, size-off))`, then push the bytes. The push
     may take several ticks (`send` returns partial counts); the next chunk is fetched only once the last is fully
     pushed.
  4. After the last byte, wait for `OK <id> <len>:<path>` / `ERR`, up to 60 s + size/4 KB per second. Then
     `post_done` with `{"ok":true,"savedAs":"<path>"}` and refetch.
  5. A zero-size file goes straight from `GO` to the wait.
- **The outcome post:** non-ASCII bytes in JSON strings are written as `\u00XX`, and `"` and `\` are escaped. A failed
  `post_done` is retried on the next `as_step`, and nothing else happens until it lands. A 409 counts as landed.
- **Failures mid-file:**
  - a failed chunk (`<0`, e.g. -409 after a cancel) closes the socket (Receive drops its temp file) and refetches
    the queue; no `post_done`;
  - the socket closing mid-file (`recv_line < 0` or `send < 0`) means no `post_done`; the file stays queued and is
    sent again on the next connection.
- **Idle:** with nothing to send, send `PING\n` every 30 s; a missing `PONG` for 10 s closes the socket and sets
  `'u'`.
- **`as_has_work`** is true from `FILE` sent until the outcome is posted, and while a fetch is owed.

- [ ] **Step 1: Write the failing tests.** In `test/test_amiga_send.c`, a scripted fake implements `as_ops_t`:
  - a `sock` state;
  - an outbound buffer of everything `send` accepted, with an optional per-call accept limit;
  - a queue of inbound lines;
  - `fetch_queue` returns a set text;
  - `fetch_chunk` returns bytes from a set file, or a set error;
  - `post_done` records `(id, json)` and returns a set status;
  - a settable clock.

  Each behaviour line above is one `static void` test, using `harness.h`. The tests named in Review Focus:
  - `drop_mid_data_posts_nothing_and_resends`: socket closed after the first chunk; reconnect; the same `FILE` goes out
    again from offset 0;
  - `receive_closed_mid_file`: `recv_line` returns -1 → no `post_done`;
  - `cancel_409_aborts`: `fetch_chunk` returns -409 → close, refetch, no `post_done`;
  - `partial_send_finishes_chunk_before_next_fetch`: accept limit of 1000 bytes per call → `fetch_chunk` is called
    again only after 16,384 bytes went out;
  - `json_escapes_latin1`: saved as `Caf\xe9.txt` → posted `{"ok":true,"savedAs":"Café.txt"}`.

  Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'amiga_send|FAIL'`. Expected: compile error (missing header).

- [ ] **Step 2: Implement `amiga_send.h/.c`.**
  - **Structure:** one `switch` on a phase enum: `IDLE`, `CONNECTING`, `HELLO`, `READY`, `FILE_SENT`, `DATA`,
    `AWAIT_OK`, `POST`.
  - **Buffers:** the queue text in `char queue[AS_QUEUE_BYTES+1]`, the chunk in `uint8_t chunk[AS_CHUNK_BYTES]`, both
    inside the struct (it is a single static instance in main.c); the current id, size, offset, chunk length and
    pushed count; a pending-done JSON buffer of 400 bytes.
  - **Lines in** are compared with `strncmp`; ids are matched exactly.
  - **No `malloc`, no recursion, no `sleep`.**
  - **Logs**, through the same `wf_logf` the other modules use (`#include "wf_log.h"`, or whatever `device_client.c`
    includes):
    - `send: receiver connected <a.b.c.d>`;
    - `send: <id8> sent <n> -> OK <path>`;
    - `send: <id8> ERR <code>`;
    - `send: <id8> aborted (<why>)`.

  Run the tests. Expected: `test_amiga_send.c: … 0 failed`, and the whole host suite still passes.

- [ ] **Step 3: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_send.* wifi-floppy/firmware/test/test_amiga_send.c
git commit -m "fw send: the board's sending state machine (handshake, queue, chunks, outcomes, pings), host-tested"
```

---

### Task 5: `device_client`: the three requests and the poll fields

**Files:**
- Modify: `wifi-floppy/firmware/src/device_client.h`, `src/device_client.c`, `test/test_device_client.c`

**Interfaces:**
- Consumes: the server routes (Task 2) and the poll fields (Task 3).
- Produces:

```c
int dc_fetch_send_queue(device_client_t *c, char *buf, int cap);            /* body length, <0 */
int dc_fetch_send_chunk(device_client_t *c, const char *id, uint32_t off, uint32_t len, uint8_t *buf); /* bytes, -status */
int dc_post_send_done(device_client_t *c, const char *id, const char *json); /* http status, <0 */
void dc_set_send(device_client_t *c, uint32_t acked_version, char rx);     /* what the next poll reports */
/* after a poll: c->send_version (uint32_t) holds xfer.v, c->send_seen true once any poll carried xfer */
```

- [ ] **Step 1: Failing tests** in `test/test_device_client.c`, using `transport_fake`:
  1. After `dc_set_send(c, 4, 'c')`, the next poll request path contains `&xferAck=4&rx=c`. Before any
     `dc_set_send`, the path has no `xferAck`: an untouched board polls exactly as 1.13 did.
  2. A poll body `{"version":1,…,"xfer":{"v":7}}` sets `c->send_version` = 7. A body without `xfer` leaves it
     unchanged.
  3. `dc_fetch_send_queue` sends `GET /api/device/send/queue`. A pushed 200 body is copied, and its length returned.
     A 500 → -1.
  4. `dc_fetch_send_chunk(c,"abc",16384,16384,buf)` sends `GET /api/device/send/abc?offset=16384&length=16384` and
     returns the byte count. A 409 → -409. A body longer than `len` → -1 (refused, never overrun).
  5. `dc_post_send_done` sends `POST /api/device/send/abc/done` with the JSON body and returns the status.
  6. The worst-case poll path (all acks at 10 digits, `xferAck` 10 digits, `rx`) fits the path buffer. Assert the
     computed length is under the new size. The existing `test_status_body_fits_at_maximum` stays green.

  Copy the request-capture idiom from the existing poll tests (`fake_last_request`). Expected: FAIL.

- [ ] **Step 2: Implement**
  - **The poll path:**
    - raise `static char path[128]` to `[176]`;
    - append `"&xferAck=%lu&rx=%c"` when `c->_send_on` (set by `dc_set_send`);
    - recompute the worst case in the comment (121 + 30 = 151 < 176);
    - raise `DC_REQ_BUF_BYTES` by 48 and update its worst-case comment.
  - **`dc_take_xfer(c, json)`:** modelled on `dc_take_df1`. A `static char obj[48]`;
    `json_object(json, "xfer", obj, sizeof obj, true)`; `json_u32_strict(obj, "v", &v)`; it sets `c->send_version`
    and `c->send_seen`. Call it first in the `dc_take_*` chain at `device_client.c:2092`.
  - **The three calls** follow `dc_fetch_firmware` (`device_client.c:1826`):
    - a static path and request, `http_build_request`, `dc_exchange` with a bytes sink, status mapping;
    - the chunk call refuses a body larger than `len` (`dc_bytes_sink` drops the excess: compare the received length
      with `r.content_length`);
    - the POST passes the JSON as the body argument.

  Run the host suite. Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add wifi-floppy/firmware/src/device_client.* wifi-floppy/firmware/test/test_device_client.c
git commit -m "fw send: device_client fetches the send queue and chunks, posts outcomes; the poll reports xferAck and rx, reads xfer.v"
```

---

### Task 6: lwIP TCP to the Amiga, core1 wiring, 1.14.0

**Files:**
- Create: `wifi-floppy/firmware/src/amiga_tcp.h`, `src/amiga_tcp.c`
- Modify: `wifi-floppy/firmware/test/run.sh` (exclude `amiga_tcp.c`, with a comment like the others),
  `src/main.c`, `CMakeLists.txt` (`FIRMWARE_SEMVER "1.14.0"`; add `src/amiga_tcp.c` and `src/amiga_send.c` to the
  sources list if it is explicit)

**Interfaces:**
- Consumes: `as_ops_t` (Task 4); the `dc_*` send calls (Task 5); `pnet_bridge_stats().amiga_ip` and `net.on`
  (`main.c:2301-2317`).
- Produces: `void amiga_tcp_ops(as_ops_t *ops, device_client_t *c)`, which fills the socket ops (lwIP) and the HTTP ops
  (`dc_*`).

- [ ] **Step 1: `amiga_tcp.c`.** A single static connection.
  - **`connect`:** under `net_radio_lock()`:
    - `tcp_new_ip_type(IPADDR_TYPE_V4)`, then `tcp_arg`, `tcp_recv`, `tcp_err` and `tcp_sent` callbacks;
    - `tcp_connect(pcb, &ip, port, on_connected)`; unlock.
  - **Callbacks** run in the network context and only set state or copy into a 1,024-byte inbound ring:
    - `on_connected` → OPEN;
    - `on_err` → the pcb is already freed: set pcb NULL; REFUSED when the error is `ERR_RST` while CONNECTING, else
      CLOSED;
    - `on_recv` with a NULL pbuf → CLOSED. Otherwise copy into the ring (drop and close if it is full), then
      `tcp_recved`, then `pbuf_free`.
  - **`send`:** under the lock: `n = min(n, tcp_sndbuf(pcb))`; `tcp_write(pcb, b, n, TCP_WRITE_FLAG_COPY)`;
    `tcp_output`; it returns n, or -1 if the pcb is NULL.
  - **`recv_line`:** takes bytes up to the LF out of the ring (under the lock), drops a `\r`, and returns 1, 0, or -1
    when CLOSED and the ring holds no LF.
  - **`close`:** under the lock: `tcp_arg(NULL)`, then `tcp_close`, falling back to `tcp_abort`.
  - **The HTTP ops** wrap `dc_fetch_send_queue`, `dc_fetch_send_chunk` and `dc_post_send_done`; `now_ms` is
    `to_ms_since_boot(get_absolute_time())`.

  Check `MEMP_NUM_TCP_PCB`: with TLS (one pcb) and this connection (one), lwIP's default leaves room. Record the value
  in the code comment.

- [ ] **Step 2: Wire core1 (`main.c`).**
  - **Startup:** a static `amiga_send_t g_send` and `as_ops_t g_send_ops`, with `amiga_tcp_ops(&g_send_ops, &c)` and
    `as_init(&g_send, &g_send_ops)` after `c` is ready.
  - **Every pass**, where `net` is filled (around `main.c:2301-2317`):

    ```c
    as_set_inputs(&g_send, net.on, net.on ? st.amiga_ip : 0, c.send_version);
    as_tick(&g_send);
    dc_set_send(&c, as_acked_version(&g_send), as_rx(&g_send));
    ```

  - **The branch** goes before the `else` that polls (`main.c:2412`), after the firmware updater's branch:

    ```c
    } else if (as_has_work(&g_send)) {
        // A file is moving to the Amiga (Phase 4): one chunk or one queue fetch per pass, no long poll -- the
        // single HTTPS connection is needed for the chunks, as for the uploader above.
        as_step(&g_send);
        s = c.state;
    ```

  - **`#if DF1_CAPABLE` guard:** the whole thing goes inside it only if `net` is (check how `pnet_bridge_stats` is
    guarded and match it).

- [ ] **Step 3: Build**

Run:

```bash
export PICO_SDK_PATH=…   # as HANDOFF says
pnpm firmware:build > /tmp/fw-build.log 2>&1; tail -20 /tmp/fw-build.log
pnpm firmware:test > /tmp/fw-test.log 2>&1; tail -5 /tmp/fw-test.log
```

Expected: the build succeeds with no new warnings, and the version reads `1.14.0+g<sha>`; the host tests are all
green.

- [ ] **Step 4: Commit**

```bash
git add wifi-floppy/firmware/src/amiga_tcp.* wifi-floppy/firmware/src/main.c wifi-floppy/firmware/test/run.sh wifi-floppy/firmware/CMakeLists.txt
git commit -m "fw send: lwIP TCP to the Amiga over the PaulaNET local path, core1 sends between polls; firmware 1.14.0"
```

---

### Task 7: Rollout and the A500 bench (operator steps are asked for, one at a time)

- [ ] **Step 1: Whole-branch review** (opus), then fix Critical and Important findings with TDD, as executing-plans
  says.
- [ ] **Step 2: e2e for the touched areas** (PORT=3100, foreground chunks under 9 minutes): `e2e/device-poll.spec.ts`,
  `e2e/device-status.spec.ts`, `e2e/device-protocol.spec.ts`, and a new `e2e/device-send.spec.ts`:
  - `pairDevice`;
  - queue via `queueTransferFromBlob`, after seeding a blob with `diskStore.put` (use the helpers' `getDb`);
  - a poll with `xferAck=0` returns `xfer.v` ≥ 1;
  - `GET /api/device/send/queue` shows `NEXT`;
  - two chunk GETs give the bytes;
  - POST done gives 204, and the queue then reads `NEXT -`;
  - cleanup.
- [ ] **Step 3: Ask the operator:** apply migration 0040 to production (additive: a new table, three new nullable or
  defaulted columns). Then merge `feat/send-board` and push master; the server goes first. Old boards are unaffected
  (Review Focus 4, pinned in Task 3).
- [ ] **Step 4: TEST build on the bench board.**
  - Publish the TEST build with `pnpm firmware:publish --no-github`, as HANDOFF 3bm describes for TEST builds.
  - Ask the operator to switch the Amiga off (the install ejects the disk), then install it as before.
  - Confirm "update to 1.14.0+g… confirmed", and check the heap low-water against 28,672.
- [ ] **Step 5: The A500 bench.** Ask the operator to switch the Amiga on. Before increment 3 has put `Receive` on the
  driver disk, it comes from the ReceiveTest disk in the library. Then:
  1. DF1 Network, `AddNetInterface eth0`, `Receive TO RAM:`. The log shows `send: receiver connected …`, and the poll
     shows `rx=c`.
  2. `pnpm send:queue <deviceId> <file>` with a small text file, after the operator's yes (it writes production). It
     arrives, and the row becomes `delivered` with `saved_as`.
  3. An 880 KB ADF: time it, and ping the router during the transfer.
  4. Close `Receive` mid-file: the row stays `sending`, and reopening it delivers the file again whole.
  5. Queue a file while `Receive` is closed. The log shows connect retries at 5 s; starting `Receive` delivers it.
  6. Cancel a queued file with a SQL `update`, using `cancelTransfer` through a one-line tsx call (operator's yes):
     the chunk route returns 409, and the board aborts and refetches.
  7. 1.13 behaviour is unchanged: the second drive, Next and NFC on DF0 still work as before.
- [ ] **Step 6: HANDOFF section** with the results, numbers and rulings, plus a memory update. Promote the TEST build
  to a release only when the operator says so.
