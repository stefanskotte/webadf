# NET: volumes — server and web (phase 1, step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files can list a board's Amiga volumes and drawers under `NET:/<board>/<Volume>/…`, read-only, and copy files out of them into STASH: or LIBRARY:, with everything the board and Transfer will speak defined and exercised by a fake board — inert in production until a board on firmware 1.22 sends `reqAck`.

**Architecture:** A `remote_requests` table is the queue between browser and board. The NET: driver turns a volume path into a request (or a remembered answer younger than 2 minutes); the board, woken by the existing long poll (`req:{v}` against `reqAck`), fetches waiting requests as protocol lines from `GET /api/device/req` and posts Transfer's answer lines back to `POST /api/device/req/<rid>`. A copy out of a volume becomes one `get` request per file; the board relays Transfer's upload with `"request":"<rid>"` in the open body, and the upload's close places the file at the copy's target.

**Tech Stack:** Next.js 16 (route params are Promises), drizzle-orm on Postgres (migrations via `drizzle-kit generate`), zod, vitest (unit + `pnpm test:db`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-30-net-volumes-design.md` (this plan = its §6 step 1: §4 and §5, plus the board-facing contract of §3 the server must speak). Transfer 2.3 (§2) and firmware 1.22 (§3) get their own plans.

## Global Constraints

- Firmware floor for browsing: `BROWSE_FW = '1.22.0'`; Transfer protocol for browsing: `3`.
- Remembered listing window: 2 minutes (`REMEMBER_MS = 120_000`). Pane re-asks every 500 ms; gives up after 20 s.
- A listing request `sent` but unanswered for 60 s is failed `timeout`; a `get` not `done` 10 minutes after it was `sent` is failed `timeout` ("A500 stopped answering").
- Copy out of a volume: at most 64 files and 16 MB per copy, 4 MB per file (`SEND_QUEUE`-like limits: `FETCH_MAX_FILES = 64`, `FETCH_MAX_BYTES = 16 * 1024 * 1024`, file max = `UPLOAD_FILE_MAX` = 4 MB).
- Board fetch: at most 8 requests per `GET /api/device/req`.
- Drawer listings are cut at 1000 entries by Transfer (`DONE <rid> 1000 cut`); the pane shows "Only the first 1000 entries are shown".
- Rows of `remote_requests` older than 24 h are deleted when a new request is added (no cron).
- Request id: `[A-Za-z0-9_-]{1,40}` (we mint 22-character base64url ids).
- Wire text is Latin-1; in JSON the board escapes bytes ≥ 0x80 as `\u00XX` (as `/api/device/upload` today). Length prefixes count characters (= bytes in Latin-1).
- Pane words (verbatim): "Reading <Volume>:<path> from <Board>…", "<Board> didn't answer — Refresh to try again", "Switch on browsing in Transfer on <Board>", "Transfer 2.3 or newer is needed on <Board>", "Firmware 1.22 or newer is needed", "Transfer is not running on <Board>", "Object not found", "Read-only for now", "Only the first 1000 entries are shown", "read <n> s ago" / "read <n> min ago", "Copying <i> of <n> from <Board>…", "<Board> stopped answering".
- Self-host parity: nothing here may depend on Vercel-only services; no new cron.
- Commits carry no attribution or session trailer. Never `git add -A`, never `git stash`.
- e2e only via `PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`, foreground, each run under 9 minutes.
- DB tests: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db <path>`.

## Rulings made while planning (spec silent or refined)

- P1 **Pending listings reuse the list route.** Spec §4.4 names `GET /api/files/net/request/<rid>`; instead `GET /api/files/list?path=` answers **202** `{ pending: true, label }` while the latest request for that path waits, and the pane simply re-asks the same URL every 500 ms (without `fresh`). One endpoint, no request id in the browser. Cost if wrong: a small extra route later.
- P2 **Capability is reported on the poll**, beside `rx` (spec §3 said `/api/device/status`): `?rxv=2|3&browse=0|1`, stored in `devices.rx_proto` and `devices.browse_on`. The receiver state already arrives there each poll. Cost if wrong: the firmware plan moves two query params.
- P3 **The drawer walk of a copy is driven by the pane:** before posting the copy, the pane lists every picked drawer (recursively, fresh) through the normal pending loop; the server then expands drawers only from answers younger than 2 minutes and refuses (`conflict`, "List the drawer again and retry") when one is missing. Keeps `OpRequest` unchanged and the limits on the server.
- P4 **Clashes for a copy out** are decided at the start, against the destination's names at that moment: `ask` returns the usual clashes; `skip` drops those tops; `replace` marks them so each arriving file replaces a *file* at its exact path; `keep-both` (and any clash that appears later) stores under the keep-both name.
- P5 **A file copied to LIBRARY:** lands first in the STASH: root (keep-both), then goes through `addUploadToLibrary` and, for a collection, `addGameToCollection` — exactly as Add to library leaves a STASH: row today.
- P6 **Fetched uploads are `source = 'copy'`**, so they never count as "from the Amiga" on the board card.
- P7 **A `get` request's states:** `waiting` → `sent` (board took it) → `fetching` (GOT seen; upload open) → `done` (upload closed and placed) / `failed`.
- P8 **Download of a volume file** = a one-file copy into the STASH: root (spec §4.5), then the existing STASH: download of the arrived row.

## Review Focus

1. **A board that never answers** (Transfer quit, board offline mid-request): the pane must stop at 20 s with the "didn't answer" words, and a later non-fresh visit must make a new request rather than show the old failure forever. Pinned in Task 3 (`latestFor` treats a failed answer older than 10 s as absent) and Task 7 (pane deadline).
2. **Two tabs or two panes asking for the same drawer at once** must share one request, not queue two. Pinned in Task 3 (`requestListing` reuses a waiting/sent one).
3. **Names with Latin-1 characters and spaces** (`Würfel Spiel`, `RAM Disk`) must round-trip through the NET: path, the request line's length prefix and the answer. Pinned in Task 2 (wire) and Task 5 (driver).
4. **A board answering someone else's request id** (another board, another org) must be refused and change nothing. Pinned in Task 4.
5. **A copy whose destination STASH: folder fills up mid-way** (500 files / 256 MB area limit): the arriving file fails with the area's reason, the other files continue, and the summary names it. Pinned in Task 6.

---

## File map

| File | Responsibility |
|---|---|
| `src/db/schema/remote-requests.ts` (new) | the `remote_requests` table |
| `src/db/schema/devices.ts` | `reqVersion`, `rxProto`, `browseOn` columns |
| `drizzle/0053_*.sql` (generated) | the migration |
| `src/lib/remote-limits.ts` (new) | constants (CLIENT-SAFE) |
| `src/lib/remote-wire.ts` (new) | request lines out, answer lines in, NET:↔Amiga paths (CLIENT-SAFE, pure) |
| `src/lib/remote-requests.ts` (new) | the request store (SERVER ONLY) |
| `src/lib/remote-browse.ts` (new) | whether a board can be browsed now, and the words why not (CLIENT-SAFE, pure) |
| `src/app/api/device/req/route.ts`, `src/app/api/device/req/[rid]/route.ts` (new) | the board's fetch and answer |
| `src/app/api/device/poll/route.ts` | `reqAck`, `req:{v}`, `rxv`/`browse` |
| `src/lib/files/net-driver.ts` | Queue folder, volumes, drawers, pending |
| `src/lib/files/net-fetch.ts` (new) | copy out of a volume: start, progress, placement |
| `src/lib/amiga-uploads.ts`, `src/app/api/device/upload/route.ts`, `.../upload/[id]/close/route.ts` | `request` on open, placement on close |
| `src/app/api/files/list/route.ts` | `fresh`, 202 pending |
| `src/app/api/files/net/fetch/[id]/route.ts` (new) | progress of a copy out |
| `src/lib/files/net-rules.ts`, `src/lib/files/pane-rules.ts`, `src/lib/files/bank.ts` | client rules: read-only reasons, Refresh, labels |
| `src/components/files/files-manager.tsx`, `pane.tsx`, `button-bank.tsx` | the pending loop, Refresh, copy-out progress |
| `src/lib/help/topics.tsx` | "Browsing the Amiga" |
| `e2e/amiga-board.ts`, `e2e/files-net-volumes.spec.ts`, `e2e/files-net-volumes.mobile.spec.ts` (new) | fake board + e2e |

---

### Task 1: Schema, migration 0053, limits

**Files:**
- Create: `src/db/schema/remote-requests.ts`, `src/lib/remote-limits.ts`
- Modify: `src/db/schema/devices.ts` (beside `sendVersion`, ~line 244), the schema barrel that re-exports tables (find it: `grep -rn "amigaUploads" src/db/schema/index.ts src/db/index.ts`)
- Generate: `drizzle/0053_<name>.sql` + `drizzle/meta/*` via `pnpm exec drizzle-kit generate`
- Test: `src/lib/remote-requests.db.test.ts` (created here with one schema test; Task 3 adds to it)

**Interfaces:**
- Produces: `remoteRequests` table object; `devices.reqVersion`, `devices.rxProto`, `devices.browseOn`; constants in `remote-limits.ts`.

- [ ] **Step 1: Write the limits module**

```ts
// src/lib/remote-limits.ts
// NET: volumes (spec 2026-10-30): the numbers the board, the server and the pane share. CLIENT-SAFE.
export const BROWSE_FW = '1.22.0';
export const BROWSE_PROTO = 3;
export const REMEMBER_MS = 120_000;          // a done listing is reused this long (V3)
export const PANE_ASK_MS = 500;              // the pane re-asks a pending listing this often
export const PANE_GIVE_UP_MS = 20_000;       // ... and stops after this long
export const FAILED_SHOWN_MS = 10_000;       // a failed answer is shown to re-asks this long, then a visit asks again
export const LIST_TIMEOUT_MS = 60_000;       // a vols/dir request sent this long ago without an answer fails `timeout`
export const GET_TIMEOUT_MS = 600_000;       // a get not done 10 minutes after it was sent fails `timeout`
export const REQUEST_KEEP_MS = 24 * 3600_000;
export const REQ_FETCH_MAX = 8;              // requests per GET /api/device/req
export const FETCH_MAX_FILES = 64;
export const FETCH_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_CUT = 1000;
export const QUEUE_FOLDER = 'Queue';
```

- [ ] **Step 2: Write the table**

```ts
// src/db/schema/remote-requests.ts
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { devices } from './devices';

/**
 * NET: volumes (spec 2026-10-30 §4.1): one request from Files to a board's Transfer. kind vols | dir | get; status
 * waiting (not yet fetched by the board) | sent | fetching (get: GOT seen) | done | failed. `answer`: the parsed
 * volumes or entries (vols/dir); `target`: where a get's file goes ({fetchId, dest, rel, replace}); `upload_id`: the
 * amiga_uploads row a get's file arrives in.
 */
export const remoteRequests = pgTable('remote_requests', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  deviceId: text('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  /** The Amiga's own path, `Work:Programs` (vols: ''). Latin-1 characters, as UTF-8 text. */
  amigaPath: text('amiga_path').notNull().default(''),
  status: text('status').notNull().default('waiting'),
  errorCode: text('error_code'),
  errorText: text('error_text'),
  answer: jsonb('answer'),
  pieces: integer('pieces').notNull().default(0),
  cut: boolean('cut').notNull().default(false),
  target: jsonb('target'),
  fetchId: text('fetch_id'),
  uploadId: text('upload_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
}, (t) => [
  index('remote_requests_device_idx').on(t.deviceId, t.status, t.createdAt),
  index('remote_requests_path_idx').on(t.deviceId, t.kind, t.amigaPath, t.createdAt),
  index('remote_requests_fetch_idx').on(t.fetchId),
]);
```

Add to `devices` beside `sendVersion`:

```ts
  /** NET: volumes (spec 2026-10-30): cursor bumped on every new remote request; the poll's `req.v`, echoed as ?reqAck=. */
  reqVersion: integer('req_version').notNull().default(0),
  /** Transfer's protocol on the board's connection (?rxv=): 2 or 3; null before a 1.22 board reports. */
  rxProto: integer('rx_proto'),
  /** Transfer's browsing switch from READY 3 (?browse=1). */
  browseOn: boolean('browse_on').notNull().default(false),
```

Export `remoteRequests` from the schema barrel the same way `amigaUploads` is exported.

- [ ] **Step 3: Generate the migration**

Run: `pnpm exec drizzle-kit generate --name net_volumes`
Expected: a new `drizzle/0053_net_volumes.sql` with `CREATE TABLE "remote_requests"`, three `CREATE INDEX`, three `ALTER TABLE "devices" ADD COLUMN`, and `_journal.json` gains entry 53. Read the SQL; it must contain nothing else (no drops). If drizzle-kit names the file differently, keep its name.

- [ ] **Step 4: Write the failing schema test**

```ts
// src/lib/remote-requests.db.test.ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

describe('remote_requests schema', () => {
  it('has the table and the device columns', async () => {
    const db = getDb();
    const t = await db.execute(sql`select to_regclass('public.remote_requests') as t`);
    expect((t.rows ?? t)[0].t).toBe('remote_requests');
    const c = await db.execute(sql`select column_name from information_schema.columns where table_name = 'devices'
      and column_name in ('req_version','rx_proto','browse_on') order by column_name`);
    expect((c.rows ?? c).map((r: { column_name: string }) => r.column_name)).toEqual(['browse_on', 'req_version', 'rx_proto']);
  });
});
```

(Follow the result-shape idiom other `*.db.test.ts` files in `src/lib` use for `db.execute`; adjust `(t.rows ?? t)` to it.)

- [ ] **Step 5: Run it**

Run: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db src/lib/remote-requests.db.test.ts`
Expected: PASS (the test DB is migrated by the harness; if it is not, run `pnpm db:migrate` against `TEST_DATABASE_URL` as the other DB tests' setup does — check `scripts/dev-db.sh`). Before Step 3 it would FAIL; if you did Step 4 first, watch it fail.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/remote-requests.ts src/db/schema/devices.ts src/lib/remote-limits.ts drizzle/0053_* drizzle/meta src/lib/remote-requests.db.test.ts <the barrel file>
git commit -m "NET: volumes: remote_requests table, device columns, limits (migration 0053)"
```

---

### Task 2: Wire format and paths (pure)

**Files:**
- Create: `src/lib/remote-wire.ts`, `src/lib/remote-wire.test.ts`

**Interfaces:**
- Consumes: `DIR_CUT`, `QUEUE_FOLDER` from Task 1.
- Produces:
  - `type RemoteKind = 'vols' | 'dir' | 'get'`
  - `requestLine(r: { id: string; kind: RemoteKind; amigaPath: string }): string` — one line with trailing `\n`.
  - `type VolumeInfo = { name: string; device: string; size: number; free: number; date: string /* ISO */ }`
  - `type EntryInfo = { name: string; dir: boolean; size: number; protection: number; date: string; comment: string }`
  - `type AnswerLine = { t: 'vol'; v: VolumeInfo } | { t: 'ent'; e: EntryInfo } | { t: 'done'; count: number; cut: boolean } | { t: 'err'; code: string; text: string } | { t: 'got'; tag: string }`
  - `parseAnswerLine(rid: string, line: string): AnswerLine | null` — null when malformed or for another rid.
  - `amigaPathOf(segments: string[]): { volume: string; amigaPath: string } | null` — `['Work','Programs','x']` → `Work:Programs/x`; `['RAM Disk']` → `RAM Disk:`.
  - `volumeLabel(v: VolumeInfo, all: VolumeInfo[]): string` — duplicate names get ` (DF1:)`; a volume named `Queue` always gets its device.
  - `amigaDateIso(days: number, mins: number, ticks: number): string`.
  - `newRequestId(): string` — 22 chars base64url from `crypto.getRandomValues`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/remote-wire.test.ts
import { describe, expect, it } from 'vitest';
import { amigaDateIso, amigaPathOf, newRequestId, parseAnswerLine, requestLine, volumeLabel, type VolumeInfo } from './remote-wire';

describe('requestLine', () => {
  it('writes VOLS, DIR and GET with length-prefixed Latin-1 paths', () => {
    expect(requestLine({ id: 'r1', kind: 'vols', amigaPath: '' })).toBe('VOLS r1\n');
    expect(requestLine({ id: 'r1', kind: 'dir', amigaPath: 'Work:Programs' })).toBe('DIR r1 13:Work:Programs\n');
    expect(requestLine({ id: 'r1', kind: 'get', amigaPath: 'Work:Würfel Spiel/a.lha' })).toBe('GET r1 23:Work:Würfel Spiel/a.lha\n');
  });
});

describe('parseAnswerLine', () => {
  it('reads VOL, ENT, DONE (with and without cut), ERR, GOT', () => {
    expect(parseAnswerLine('r1', 'VOL r1 4:Work 4:DH1: 104857600 41943040 17000.600.0')).toEqual({ t: 'vol',
      v: { name: 'Work', device: 'DH1:', size: 104857600, free: 41943040, date: amigaDateIso(17000, 600, 0) } });
    expect(parseAnswerLine('r1', 'ENT r1 f 2210 0f 16500.0.50 6:ReadMe 0:')).toEqual({ t: 'ent',
      e: { name: 'ReadMe', dir: false, size: 2210, protection: 0x0f, date: amigaDateIso(16500, 0, 50), comment: '' } });
    expect(parseAnswerLine('r1', 'ENT r1 d 0 0 16500.0.0 5:My Dr 3:a b')).toMatchObject({ t: 'ent', e: { name: 'My Dr', dir: true, comment: 'a b' } });
    expect(parseAnswerLine('r1', 'DONE r1 3')).toEqual({ t: 'done', count: 3, cut: false });
    expect(parseAnswerLine('r1', 'DONE r1 1000 cut')).toEqual({ t: 'done', count: 1000, cut: true });
    expect(parseAnswerLine('r1', 'ERR r1 notfound 16:object not found')).toEqual({ t: 'err', code: 'notfound', text: 'object not found' });
    expect(parseAnswerLine('r1', 'GOT r1 12')).toEqual({ t: 'got', tag: '12' });
  });
  it('refuses malformed lines and other ids', () => {
    expect(parseAnswerLine('r1', 'VOL r2 4:Work 4:DH1: 1 1 1.1.1')).toBeNull();
    expect(parseAnswerLine('r1', 'ENT r1 x 1 0 1.1.1 1:a 0:')).toBeNull();
    expect(parseAnswerLine('r1', 'ENT r1 f 1 0 1.1.1 9:a 0:')).toBeNull();      // length says 9, one character follows
    expect(parseAnswerLine('r1', 'ENT r1 f 1 0 1.1.1 1:/ 0:')).toBeNull();      // a name with '/' or ':' is not a name
    expect(parseAnswerLine('r1', 'DONE r1 -1')).toBeNull();
    expect(parseAnswerLine('r1', 'ERR r1 bogus! 1:x')).toBeNull();
    expect(parseAnswerLine('r1', 'HELLO')).toBeNull();
  });
});

describe('amigaPathOf', () => {
  it('turns NET: segments below the board into an Amiga path', () => {
    expect(amigaPathOf(['Work'])).toEqual({ volume: 'Work', amigaPath: 'Work:' });
    expect(amigaPathOf(['RAM Disk', 'T'])).toEqual({ volume: 'RAM Disk', amigaPath: 'RAM Disk:T' });
    expect(amigaPathOf(['Work', 'Würfel Spiel', 'a.lha'])).toEqual({ volume: 'Work', amigaPath: 'Work:Würfel Spiel/a.lha' });
    expect(amigaPathOf(['Empty (DF1:)', 'c'])).toEqual({ volume: 'Empty (DF1:)', amigaPath: 'Empty (DF1:):c' });
  });
  it('refuses names AmigaDOS would not take', () => {
    expect(amigaPathOf([])).toBeNull();
    expect(amigaPathOf(['Work', 'a:b'])).toBeNull();
    expect(amigaPathOf(['Work', 'x'.repeat(31)])).toBeNull();
  });
});

describe('volumeLabel', () => {
  const v = (name: string, device: string): VolumeInfo => ({ name, device, size: 0, free: 0, date: '' });
  it('adds the device to a duplicate name, and always to a volume named Queue', () => {
    const all = [v('Empty', 'DF0:'), v('Empty', 'DF1:'), v('Work', 'DH1:'), v('Queue', 'DH2:')];
    expect(all.map((x) => volumeLabel(x, all))).toEqual(['Empty (DF0:)', 'Empty (DF1:)', 'Work', 'Queue (DH2:)']);
    expect(volumeLabel(v('empty', 'DF0:'), [v('empty', 'DF0:'), v('EMPTY', 'DF1:')])).toBe('empty (DF0:)');
  });
});

describe('newRequestId', () => {
  it('is 22 base64url characters and differs each time', () => {
    const a = newRequestId(); const b = newRequestId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });
});
```

Ruling inside this task: the volume segment is exempt from `amigaNameProblem`'s `:` rule only for the ` (DEVn:)` suffix form (`/^.+ \([A-Z]+[0-9]*:\)$/`); every other segment must pass `amigaNameProblem` (from `src/lib/files/path.ts`). Transfer resolves the suffix form (spec §2.2). When a duplicate exists every copy carries its device (both `Empty (DF0:)` and `Empty (DF1:)`), so neither is ambiguous — the spec's "the second" is read as "each".

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/remote-wire.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/remote-wire.ts
// NET: volumes (spec 2026-10-30 §2.2): the request lines the board passes to Transfer, the answer lines it brings
// back, and NET: path <-> Amiga path. Text is Latin-1; a <len>:<text> field counts characters. CLIENT-SAFE, pure.
import { amigaNameProblem } from '@/lib/files/path';
import { QUEUE_FOLDER } from './remote-limits';

export type RemoteKind = 'vols' | 'dir' | 'get';
export type VolumeInfo = { name: string; device: string; size: number; free: number; date: string };
export type EntryInfo = { name: string; dir: boolean; size: number; protection: number; date: string; comment: string };
export type AnswerLine =
  | { t: 'vol'; v: VolumeInfo } | { t: 'ent'; e: EntryInfo } | { t: 'done'; count: number; cut: boolean }
  | { t: 'err'; code: string; text: string } | { t: 'got'; tag: string };

const lp = (s: string) => `${s.length}:${s}`;

export function requestLine(r: { id: string; kind: RemoteKind; amigaPath: string }): string {
  if (r.kind === 'vols') return `VOLS ${r.id}\n`;
  return `${r.kind === 'dir' ? 'DIR' : 'GET'} ${r.id} ${lp(r.amigaPath)}\n`;
}

/** Amiga epoch is 1978-01-01; a tick is 1/50 s. */
export function amigaDateIso(days: number, mins: number, ticks: number): string {
  return new Date(Date.UTC(1978, 0, 1) + days * 86_400_000 + mins * 60_000 + Math.floor(ticks * 20)).toISOString();
}

/** A tiny cursor over one line: words split by single spaces, and <len>:<text> fields. */
class Cursor {
  constructor(private s: string, private i = 0) {}
  word(): string | null {
    if (this.i > this.s.length) return null;
    const j = this.s.indexOf(' ', this.i);
    const w = j < 0 ? this.s.slice(this.i) : this.s.slice(this.i, j);
    this.i = j < 0 ? this.s.length + 1 : j + 1;
    return w;
  }
  lenStr(): string | null {
    const c = this.s.indexOf(':', this.i);
    if (c < 0) return null;
    const n = this.s.slice(this.i, c);
    if (!/^\d{1,4}$/.test(n)) return null;
    const end = c + 1 + Number(n);
    if (end > this.s.length || (end < this.s.length && this.s[end] !== ' ')) return null;
    const v = this.s.slice(c + 1, end);
    this.i = end + 1;
    return v;
  }
  atEnd(): boolean { return this.i >= this.s.length; }
}
const num = (w: string | null, max = 0xFFFFFFFF): number | null => (w !== null && /^\d{1,10}$/.test(w) && Number(w) <= max ? Number(w) : null);
function date(w: string | null): string | null {
  const m = w ? /^(\d{1,6})\.(\d{1,5})\.(\d{1,5})$/.exec(w) : null;
  return m ? amigaDateIso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
const NAME_OK = (n: string) => n.length > 0 && !n.includes('/') && !n.includes(':') && !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(n) && !/[^\u0000-ÿ]/.test(n);
const CODES = new Set(['off', 'notfound', 'notdir', 'isdir', 'busy', 'toolarge', 'denied', 'bad', 'io', 'norx', 'old', 'timeout']);

export function parseAnswerLine(rid: string, line: string): AnswerLine | null {
  const c = new Cursor(line);
  const verb = c.word();
  if (c.word() !== rid) return null;
  switch (verb) {
    case 'VOL': {
      const name = c.lenStr(); const device = c.lenStr();
      const size = num(c.word()); const free = num(c.word()); const d = date(c.word());
      if (name === null || !NAME_OK(name) || device === null || !/^[A-Za-z0-9]{1,30}:$/.test(device) || size === null || free === null || d === null || !c.atEnd()) return null;
      return { t: 'vol', v: { name, device, size, free, date: d } };
    }
    case 'ENT': {
      const kind = c.word(); const size = num(c.word()); const prot = c.word(); const d = date(c.word());
      const name = c.lenStr(); const comment = c.lenStr();
      if ((kind !== 'd' && kind !== 'f') || size === null || !prot || !/^[0-9a-f]{1,8}$/.test(prot) || d === null
        || name === null || !NAME_OK(name) || name.length > 30 || comment === null || comment.length > 79 || !c.atEnd()) return null;
      return { t: 'ent', e: { name, dir: kind === 'd', size, protection: parseInt(prot, 16), date: d, comment } };
    }
    case 'DONE': {
      const count = num(c.word(), 1_000_000); const rest = c.word();
      if (count === null || (rest !== null && rest !== 'cut') || !c.atEnd()) return null;
      return { t: 'done', count, cut: rest === 'cut' };
    }
    case 'ERR': {
      const code = c.word(); const text = c.lenStr();
      if (!code || !CODES.has(code) || text === null || !c.atEnd()) return null;
      return { t: 'err', code, text };
    }
    case 'GOT': {
      const tag = c.word();
      if (!tag || !/^\d{1,9}$/.test(tag) || !c.atEnd()) return null;
      return { t: 'got', tag };
    }
  }
  return null;
}

const SUFFIXED = /^.+ \([A-Za-z0-9]{1,30}:\)$/;

export function amigaPathOf(segments: string[]): { volume: string; amigaPath: string } | null {
  if (segments.length === 0) return null;
  const [volume, ...rest] = segments;
  if (!(SUFFIXED.test(volume) || amigaNameProblem(volume) === null)) return null;
  for (const s of rest) if (amigaNameProblem(s) !== null) return null;
  return { volume, amigaPath: `${volume}:${rest.join('/')}` };
}

export function volumeLabel(v: VolumeInfo, all: VolumeInfo[]): string {
  const same = all.filter((x) => x.name.toLowerCase() === v.name.toLowerCase()).length;
  return same > 1 || v.name.toLowerCase() === QUEUE_FOLDER.toLowerCase() ? `${v.name} (${v.device})` : v.name;
}

export function newRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

Note the `ENT` test fixture `'ENT r1 f 1 0 1.1.1 9:a 0:'`: the length 9 runs past the field, `lenStr` returns null.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/lib/remote-wire.test.ts`
Expected: PASS. If the `DIR r1 13:` expectation fails, count `Work:Programs` (13) — the prefix counts characters.

- [ ] **Step 5: Commit**

```bash
git add src/lib/remote-wire.ts src/lib/remote-wire.test.ts
git commit -m "NET: volumes: request and answer lines, NET: path to Amiga path"
```

---

### Task 3: The request store

**Files:**
- Create: `src/lib/remote-requests.ts`, `src/lib/remote-browse.ts`, `src/lib/remote-browse.test.ts`
- Modify: `src/lib/remote-requests.db.test.ts`

**Interfaces:**
- Consumes: Task 1 table and constants; Task 2 `requestLine`, `parseAnswerLine`, `newRequestId`, `VolumeInfo`, `EntryInfo`, `RemoteKind`.
- Produces (all `db: Db` first, `now = new Date()` last):
  - `type RemoteRow = typeof remoteRequests.$inferSelect`
  - `type ListingState = { state: 'ready'; row: RemoteRow; ageMs: number } | { state: 'pending'; row: RemoteRow } | { state: 'failed'; row: RemoteRow } | { state: 'none' }`
  - `latestFor(db, deviceId, kind: 'vols'|'dir', amigaPath, now): Promise<ListingState>` — the newest row for (board, kind, path compared case-insensitively). `done` younger than `REMEMBER_MS` → ready; `waiting`/`sent` → pending; `failed` answered within `FAILED_SHOWN_MS` → failed; anything else → none. Runs `expireStale` first.
  - `requestListing(db, { orgId, deviceId, kind, amigaPath, fresh }, now): Promise<ListingState>` — `latestFor`; when `fresh` and the state is ready/failed/none, or not `fresh` and state none → insert a new `waiting` row (bumping `devices.reqVersion` and deleting rows older than `REQUEST_KEEP_MS`, one transaction), return `{state:'pending', row}`. A pending state is returned as is (two panes share one request).
  - `addGets(db, { orgId, deviceId, fetchId, files: { amigaPath: string; target: GetTarget }[] }, now): Promise<string[]>` — inserts `get` rows (one transaction, one `reqVersion` bump), returns ids. `type GetTarget = { dest: string; rel: string[]; replace: boolean; library: { collectionId: string | null } | null }`.
  - `takeWaiting(db, deviceId, now): Promise<RemoteRow[]>` — up to `REQ_FETCH_MAX` waiting rows, oldest first, set `sent`/`sent_at` (`FOR UPDATE SKIP LOCKED`).
  - `answerPiece(db, deviceId, rid, piece: { piece: number; lines: string[]; last: boolean }, now): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 }>` — see step 3.
  - `getForUpload(db, deviceId, rid): Promise<RemoteRow | null>` — a `get` row of this board in `fetching` (or `sent`) state.
  - `settleGet(db, rid, outcome: { ok: true } | { ok: false; code: string; text: string }, now)`.
  - `expireStale(db, now)` — vols/dir `sent` older than `LIST_TIMEOUT_MS` (by `sent_at`) and `waiting` older than `LIST_TIMEOUT_MS` (by `created_at`) → failed `timeout`; get `sent`/`fetching` older than `GET_TIMEOUT_MS` (by `sent_at`) → failed `timeout` with text "stopped answering".
  - In `remote-browse.ts` (pure): `browseBlock(b: { online: boolean; firmware: string | null; rx: string | null; rxProto: number | null; browseOn: boolean; name: string; offlineWords: string }): string | null` — null when browsable, else the words, in this order: offline → `offlineWords`; firmware below `BROWSE_FW` → "Firmware 1.22 or newer is needed"; rx !== 'c' → `Transfer is not running on ${name}`; rxProto !== 3 → `Transfer 2.3 or newer is needed on ${name}`; !browseOn → `Switch on browsing in Transfer on ${name}`. And `errorWords(code: string, text: string, board: string): string` — `off` → switch words; `old` → Transfer 2.3 words; `norx` → not running words; `notfound` → "Object not found"; `timeout` → `${board} didn't answer — Refresh to try again`; others → `text` (or "Failed" when empty).

- [ ] **Step 1: Write the failing pure tests** (`src/lib/remote-browse.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { browseBlock, errorWords } from './remote-browse';

const ok = { online: true, firmware: '1.22.0', rx: 'c', rxProto: 3, browseOn: true, name: 'A500', offlineWords: 'offline 3 h' };
describe('browseBlock', () => {
  it('is null when everything allows it', () => expect(browseBlock(ok)).toBeNull());
  it('names the first missing thing', () => {
    expect(browseBlock({ ...ok, online: false, firmware: '1.0.0' })).toBe('offline 3 h');
    expect(browseBlock({ ...ok, firmware: '1.21.1' })).toBe('Firmware 1.22 or newer is needed');
    expect(browseBlock({ ...ok, rx: 'u' })).toBe('Transfer is not running on A500');
    expect(browseBlock({ ...ok, rxProto: 2 })).toBe('Transfer 2.3 or newer is needed on A500');
    expect(browseBlock({ ...ok, browseOn: false })).toBe('Switch on browsing in Transfer on A500');
  });
});
describe('errorWords', () => {
  it('maps codes to the pane words', () => {
    expect(errorWords('off', '', 'A500')).toBe('Switch on browsing in Transfer on A500');
    expect(errorWords('notfound', 'object not found', 'A500')).toBe('Object not found');
    expect(errorWords('timeout', '', 'A500')).toBe("A500 didn't answer — Refresh to try again");
    expect(errorWords('busy', 'object in use', 'A500')).toBe('object in use');
  });
});
```

- [ ] **Step 2: Write the failing DB tests** (append to `src/lib/remote-requests.db.test.ts`). Seed an org and a device the way `src/lib/amiga-uploads*.db.test.ts` or `src/lib/files/net-driver.db.test.ts` seed theirs (copy their helper usage). Cases, each its own `it`:

```ts
it('a listing request is made once and shared while it waits', async () => {
  const a = await requestListing(db, { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Programs', fresh: false });
  const b = await requestListing(db, { orgId, deviceId, kind: 'dir', amigaPath: 'work:programs', fresh: false });
  expect(a.state).toBe('pending'); expect(b.state).toBe('pending');
  expect(b.state === 'pending' && a.state === 'pending' && b.row.id === a.row.id).toBe(true);
  expect((await reqVersionOf(deviceId))).toBe(1);   // reqVersionOf: select devices.reqVersion
});
it('the board takes waiting requests as sent, at most 8', async () => { /* add 9 dir requests on distinct paths; takeWaiting → 8 rows, all status sent; second takeWaiting → 1 */ });
it('an answer in two pieces becomes a ready listing; a repeat piece changes nothing; a gap is 409', async () => {
  const p = await requestListing(db, { orgId, deviceId, kind: 'dir', amigaPath: 'Work:', fresh: false });
  const rid = (p as { row: { id: string } }).row.id;
  await takeWaiting(db, deviceId);
  expect(await answerPiece(db, deviceId, rid, { piece: 0, lines: [`ENT ${rid} f 10 0 1.0.0 1:a 0:`], last: false })).toEqual({ ok: true });
  expect(await answerPiece(db, deviceId, rid, { piece: 0, lines: [`ENT ${rid} f 10 0 1.0.0 1:a 0:`], last: false })).toEqual({ ok: true });
  expect(await answerPiece(db, deviceId, rid, { piece: 2, lines: [], last: true })).toEqual({ ok: false, status: 409 });
  expect(await answerPiece(db, deviceId, rid, { piece: 1, lines: [`ENT ${rid} d 0 0 1.0.0 1:b 0:`, `DONE ${rid} 2`], last: true })).toEqual({ ok: true });
  const s = await latestFor(db, deviceId, 'dir', 'Work:');
  expect(s.state).toBe('ready');
  expect(s.state === 'ready' && (s.row.answer as { entries: unknown[] }).entries).toHaveLength(2);
});
it('an ERR answer fails the request and is shown for 10 s, then a visit asks again', async () => { /* answer ERR notfound; latestFor → failed; latestFor at now+11 s → none; requestListing non-fresh at now+11s → pending with a new id */ });
it('a remembered listing is ready for 2 minutes, then a visit asks again; fresh always asks', async () => { /* ... at now+119 s ready, at now+121 s requestListing → new pending; fresh at now+10 s → new pending */ });
it('a malformed line fails the request with bad', async () => { /* lines: ['ENT x'] → status failed, errorCode bad */ });
it('another board cannot answer or take this board\'s request', async () => { /* second device in another org: takeWaiting(other) → []; answerPiece(other, rid) → 404 */ });
it('stale requests time out', async () => { /* sent dir at t0; latestFor at t0+61 s → failed timeout; get sent at t0, expireStale at t0+601 s → failed timeout */ });
it('rows older than a day are deleted when a request is added', async () => { /* insert a row with createdAt now-25h directly; requestListing → old row gone */ });
```

Write each body out fully in the test file (the comments above say exactly what to assert).

- [ ] **Step 3: Implement** `src/lib/remote-browse.ts` (pure, from the Interfaces above; use `firmwareAtLeast` from `@/lib/firmware-version`) and `src/lib/remote-requests.ts`. Core of `answerPiece`:

```ts
export async function answerPiece(db: Db, deviceId: string, rid: string, p: { piece: number; lines: string[]; last: boolean }, now = new Date()) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(remoteRequests).where(and(eq(remoteRequests.id, rid), eq(remoteRequests.deviceId, deviceId))).for('update');
    if (!r) return { ok: false as const, status: 404 as const };
    if (r.status === 'done' || r.status === 'failed' || p.piece < r.pieces) return { ok: true as const };   // a repeat after a lost answer
    if (p.piece > r.pieces || (r.status !== 'sent' && r.status !== 'fetching')) return { ok: false as const, status: 409 as const };
    const prev = (r.answer ?? { volumes: [], entries: [] }) as { volumes: VolumeInfo[]; entries: EntryInfo[] };
    const set: Partial<RemoteRow> = { pieces: r.pieces + 1 };
    let end: 'done' | 'failed' | null = null;
    for (const line of p.lines) {
      const a = parseAnswerLine(rid, line);
      if (!a) { Object.assign(set, { errorCode: 'bad', errorText: 'Transfer sent an answer webadf could not read' }); end = 'failed'; break; }
      if (a.t === 'vol' && r.kind === 'vols') prev.volumes.push(a.v);
      else if (a.t === 'ent' && r.kind === 'dir') prev.entries.push(a.e);
      else if (a.t === 'done' && r.kind !== 'get') { set.cut = a.cut; end = 'done'; }
      else if (a.t === 'err') { Object.assign(set, { errorCode: a.code, errorText: a.text }); end = 'failed'; }
      else if (a.t === 'got' && r.kind === 'get') set.status = 'fetching';
      else { Object.assign(set, { errorCode: 'bad', errorText: 'Transfer sent an answer webadf could not read' }); end = 'failed'; break; }
    }
    // The last piece must end the answer (vols/dir: DONE or ERR; get: GOT or ERR).
    if (p.last && end === null && !(r.kind === 'get' && set.status === 'fetching')) {
      Object.assign(set, { errorCode: 'bad', errorText: 'Transfer sent an answer webadf could not read' }); end = 'failed';
    }
    if (r.kind !== 'get') set.answer = prev;
    if (end) Object.assign(set, { status: end, answeredAt: now });
    await tx.update(remoteRequests).set(set).where(eq(remoteRequests.id, rid));
    return { ok: true as const };
  });
}
```

A `get` that fails here must also settle its fetch (Task 6 reads `status`, so nothing else is needed now). `requestListing`'s insert:

```ts
await tx.delete(remoteRequests).where(lt(remoteRequests.createdAt, new Date(now.getTime() - REQUEST_KEEP_MS)));
const [row] = await tx.insert(remoteRequests).values({ id: newRequestId(), orgId, deviceId, kind, amigaPath, createdAt: now }).returning();
await tx.update(devices).set({ reqVersion: sql`${devices.reqVersion} + 1` }).where(eq(devices.id, deviceId));
```

Case-insensitive path match: `sql\`lower(${remoteRequests.amigaPath}) = lower(${amigaPath})\``.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/remote-browse.test.ts && export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db src/lib/remote-requests.db.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/remote-requests.ts src/lib/remote-browse.ts src/lib/remote-browse.test.ts src/lib/remote-requests.db.test.ts
git commit -m "NET: volumes: the request store (listing reuse, the 2-minute memory, pieces, timeouts)"
```

---

### Task 4: Board routes and the poll

**Files:**
- Create: `src/app/api/device/req/route.ts`, `src/app/api/device/req/[rid]/route.ts`, `src/app/api/device/req/routes.db.test.ts`
- Modify: `src/app/api/device/poll/route.ts` (beside `xferAck`, ~lines 129-140, 186, 209, 301), `src/lib/xfer-wire.ts` (add `buildReq`), `src/app/api/device/poll/route.test.ts`, `src/lib/transfers.ts` (`recordSendRx` gains optional `proto`, `browse`)

**Interfaces:**
- Consumes: Task 3 `takeWaiting`, `answerPiece`; Task 2 `requestLine`.
- Produces: `GET /api/device/req` → `200 text/plain; charset=latin1` body of request lines (empty body when none); `POST /api/device/req/<rid>` JSON `{piece:int≥0, lines:string[] (each ≤ 640 chars, ≤ 400 lines), last:boolean}` → 204, or 400/404/409 `{code}`. Poll: `?reqAck=<n>` (absent = never woken), body `req: { v }` on every body for a board that sent reqAck; wake on `tick.reqVersion !== reqAck`. `?rxv=2|3&browse=0|1` recorded with `rx`.

- [ ] **Step 1: Write the failing route tests** (`routes.db.test.ts`). Follow how `src/app/api/device/upload/routes.test.ts` builds an authenticated device request (copy its token/seed helper). Cases:
  - GET with two waiting requests (a vols and a dir `Work:Würfel`) → 200, body decoded as Latin-1 equals `VOLS <id1>\nDIR <id2> 11:Work:Würfel\n`; both rows now `sent`. The body is written with `Buffer.from(text, 'latin1')`.
  - GET with none → 200, empty body.
  - POST a valid last piece → 204; the row is `done`.
  - POST to a rid of a board in another org → 404, the row unchanged.
  - POST with `piece: -1`, or a line of 641 chars, or 401 lines → 400.
  - POST the `ü`-escaped JSON the board sends (`amigaJson` style: `JSON.stringify(o).replace(/[\u0080-￿]/g, …)`) for an `ENT` named `Würfel` → the stored entry name is `Würfel`.
  - No token → 401 (as the other device routes).

- [ ] **Step 2: Add the poll cases** to `src/app/api/device/poll/route.test.ts`, mirroring the existing `xferAck` cases there: a board sending `reqAck=0` while `req_version = 2` gets a 200 with `req: { v: 2 }` at once; a board sending `reqAck=2` with nothing else moved is held (the existing hold assertion style); a board sending no `reqAck` never gets `req`; `rx=c&rxv=3&browse=1` with `xferAck` present sets `devices.rx_proto = 3`, `browse_on = true`.

- [ ] **Step 3: Run them to see them fail**

Run: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db src/app/api/device/req/routes.db.test.ts src/app/api/device/poll/route.test.ts`
(If `route.test.ts` is a plain unit test with mocks, run it with `pnpm vitest run` instead and follow its mocking of `readPollTick`.)
Expected: FAIL (routes missing, `req` absent).

- [ ] **Step 4: Implement**

`src/app/api/device/req/route.ts`:

```ts
// GET /api/device/req -- NET: volumes (spec 2026-10-30 §3, §4.2): the board's waiting requests, at most 8, as the
// lines it passes to Transfer (Latin-1). Taking them marks them sent.
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { takeWaiting } from '@/lib/remote-requests';
import { requestLine, type RemoteKind } from '@/lib/remote-wire';

export async function GET(request: Request) {
  let device;
  try { device = await requireDevice(request); } catch (e) { const res = deviceAuthResponse(e); if (res) return res; throw e; }
  const rows = await takeWaiting(getDb(), device.deviceId);
  const text = rows.map((r) => requestLine({ id: r.id, kind: r.kind as RemoteKind, amigaPath: r.amigaPath })).join('');
  return new Response(Buffer.from(text, 'latin1'), { headers: { 'content-type': 'text/plain; charset=latin1', 'cache-control': 'no-store' } });
}
```

`src/app/api/device/req/[rid]/route.ts`: zod body `{ piece: z.number().int().min(0).max(100_000), lines: z.array(z.string().max(640)).max(400), last: z.boolean() }`; `params: Promise<{ rid: string }>` (Next 16: `const { rid } = await params`); rid must match `/^[A-Za-z0-9_-]{1,40}$/` else 404; `answerPiece` → 204 or the status with `{ code: 'gone' | 'order' | 'bad' }` (404 gone, 409 order, 400 bad).

Poll: parse `reqAck` exactly as `xferAck` (same three-way null/number/0). Add `reqVersion` to `readPollTick`'s single-row select. `const reqMoved = reqAck !== null && tick.reqVersion !== reqAck;` joins the wake condition; the body gains `...(reqAck !== null ? { req: buildReq(tick.reqVersion) } : {})` with `export function buildReq(v: number): { v: number } { return { v }; }` in `xfer-wire.ts`. Record capability: after the `rx` parse,

```ts
const rxv = new URL(request.url).searchParams.get('rxv');
const browse = new URL(request.url).searchParams.get('browse');
if (xferAck !== null && rx !== null && /^[cru-]$/.test(rx)) {
  await recordSendRx(getDb(), device.deviceId, rx as 'c' | 'r' | 'u' | '-', new Date(),
    rxv === '2' || rxv === '3' ? { proto: Number(rxv), browse: browse === '1' } : undefined);
}
```

and in `recordSendRx` add the optional fourth parameter, writing `rxProto`/`browseOn` when given; its "write on a change or after 30 s" guard must also count a change of `rx_proto` or `browse_on` as a change (extend the `is distinct from` clause).

- [ ] **Step 5: Run them to see them pass**

Run: the Step 3 command.
Expected: PASS. Also run `pnpm vitest run src/lib/device-limits.test.ts` — it measures the poll body against the board's buffer; if it measures the whole body's worst size, add `req` to its worst case and keep it under the limit it asserts (report the new number).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/device/req src/app/api/device/poll/route.ts src/app/api/device/poll/route.test.ts src/lib/xfer-wire.ts src/lib/transfers.ts src/lib/device-limits.test.ts
git commit -m "NET: volumes: the board's request fetch and answer routes; the poll wakes on reqAck and records Transfer's protocol"
```

---

### Task 5: The NET: driver — Queue folder, volumes, drawers, pending

**Files:**
- Modify: `src/lib/files/net-driver.ts`, `src/lib/files/driver.ts` (list gains `opts`), `src/app/api/files/list/route.ts`, `src/lib/files/types.ts`, `src/lib/files/path.ts` (`filesHrefForBoard` → Queue), `src/lib/files/net-rules.ts` (`netPollMs` for `Queue`), `src/lib/files/net-driver.db.test.ts`
- Test: `src/lib/files/net-driver.db.test.ts`, `src/lib/files/path.test.ts`, `src/lib/files/net-rules.test.ts`

**Interfaces:**
- Consumes: Task 3 `requestListing`, `latestFor`, `browseBlock`, `errorWords`; Task 2 `amigaPathOf`, `volumeLabel`.
- Produces:
  - `VolumeDriver.list(ctx, p, opts?: { fresh?: boolean })`.
  - A new thrown signal: `export class Pending extends Error { constructor(readonly label: string) { super('pending'); } }` in `driver.ts`; the list route answers it `202 { pending: true, label }`.
  - `Listing.net?: { board: string; boardName: string; volume: string | null; amigaPath: string | null; readAt: number | null; cut: boolean; browse: string | null }` — `browse`: null when browsable, else the words (`browseBlock`).
  - `EntryKind` gains `'volume'`.
  - Paths: `NET:/<board>` lists volumes + `Queue`; `NET:/<board>/Queue` is the old queue listing; `NET:/<board>/Queue/<transferId>` the rows; `NET:/<board>/<Volume>/…` a volume or drawer. An old `NET:/<board>/<transferId>` path (a transfer id of this board) lists as… not found — the client redirect is done by `filesHrefForBoard` now pointing at `/Queue`; the driver additionally treats a 2-segment path whose second segment is a transfer id of this board as `NET:/<board>/Queue/<id>` for `remove` (old open tabs).

- [ ] **Step 1: Write the failing tests.**

In `net-driver.db.test.ts` (extend its seed with `firmwareVersion: '1.22.0'`, `sendRx: 'c'`, `sendRxAt: now`, `rxProto: 3`, `browseOn: true`, `lastSeenAt: now`), cases:
  - `NET:/<board>` with nothing remembered → throws `Pending` with label `Reading volumes from <name>…` and one `vols` request waits; after answering it (`takeWaiting` + `answerPiece` with two `VOL` lines, one named `Queue`, and `DONE`) the listing has entries `['Work', 'Queue (DH2:)', 'Queue']` in that order: volumes (in Transfer's order) then the Queue folder; kinds `volume`, `volume`, `dir`; the Work row's `sizeText` is `DH1: · 40.0 MB free`; `net.readAt` is set.
  - Same board with `browseOn: false` → no request is made; entries are just `Queue`; `net.browse` is `Switch on browsing in Transfer on <name>`.
  - `NET:/<board>/Work/Programs` with nothing remembered → `Pending` label `Reading Work:Programs from <name>…`; answered with an `ENT` file and a `ENT` drawer and `DONE … 2` → entries: the drawer as `dir` with path `NET:/<board>/Work/Programs/Sub`, the file as `file` with `protection` from `protectionString`, `writable: false`, `readOnlyReason: 'Read-only for now'`, `crumbs` `NET:` › `<name>` › `Work:` › `Programs`, `meta` = the volume's free space if the vols answer is remembered, else `''`.
  - A `DONE … cut` answer → `net.cut === true`.
  - An `ERR notfound` answer → `list` throws `Refused` with code `not_found` and detail `Object not found`; an `ERR off` answer → code `read_only`, detail `Switch on browsing in Transfer on <name>`.
  - `fresh: true` with a remembered listing → `Pending` and a second request row.
  - `NET:/<board>/Queue` → today's queue listing (the existing queue tests move to this path).
  - A path segment `a:b` under a volume → `null` (not found).
  - A board in another org → `null`.
In `path.test.ts`: `filesHrefForBoard('d1', 'right')` → `/files?left=STASH:&right=NET%3A%2Fd1%2FQueue&active=right`.
In `net-rules.test.ts`: `netPollMs` polls `NET:/d1/Queue` listings as it polled `NET:/d1` before, and returns null for `NET:/d1` and for volume paths.

- [ ] **Step 2: Run to see them fail**

Run: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db src/lib/files/net-driver.db.test.ts && pnpm vitest run src/lib/files/path.test.ts src/lib/files/net-rules.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `net-driver.ts`, `list(ctx, p, opts)`:

```ts
async function list(ctx: FsCtx, p: FsPath, opts: { fresh?: boolean } = {}): Promise<Listing | null> {
  const now = Date.now();
  if (p.segments.length === 0) return listBoards(ctx, now);
  const t = await findSendTarget(getDb(), ctx.orgId, p.segments[0], now);
  if (!t) return null;
  const [, second, ...rest] = p.segments;
  if (second === undefined) return listBoardRoot(ctx, t, now, opts);
  if (second === QUEUE_FOLDER && rest.length === 0) return listQueue(ctx, t, now);
  if (second === QUEUE_FOLDER) return null;
  return listVolume(ctx, t, p.segments.slice(1), now, opts);
}
```

- `browseOf(t)`: read `firmwareVersion`, `rxProto`, `browseOn` for the board (extend `SendTarget` in `send-targets.ts`/`send-ui.ts` with `firmwareVersion`, `rxProto`, `browseOn` rather than a second query) and call `browseBlock({ online: t.online, firmware, rx: t.rx, rxProto, browseOn, name: t.name, offlineWords: targetState(t, now) })`.
- `listBoardRoot`: `block = browseOf(t)`; when null, `const s = await requestListing(db, { orgId, deviceId: t.id, kind: 'vols', amigaPath: '', fresh: !!opts.fresh })` (ready → volumes; pending → `throw new Pending(\`Reading volumes from ${t.name}…\`)`; failed → treat as `block = errorWords(code, text, t.name)`). Entries: each volume `{ name: volumeLabel(v, all), kind: 'volume', path: netPath(t.id, label), size: null, sizeText: \`${v.device} · ${(v.free / MB).toFixed(1)} MB free\`, date: v.date, protection: null, comment: null, marks: [] }`, then `{ name: 'Queue', kind: 'dir', path: netPath(t.id, 'Queue'), size: null, date: null, protection: null, comment: null, marks: [\`${load.files} waiting\`] }`. `writable: false`, `readOnlyReason: 'Open a volume or Queue'`, `net: { board: t.id, boardName: t.name, volume: null, amigaPath: null, readAt: ready ? now - ageMs : null, cut: false, browse: block }`, meta `${n} volumes` or the block words.
- `listVolume`: `amigaPathOf(segs)` → null → return null. `block` non-null → `refuse('read_only', 409, block)`. `requestListing(… kind: 'dir', amigaPath, fresh)`; pending → `throw new Pending(\`Reading ${amigaPath} from ${t.name}…\`)`; failed → `refuse(row.errorCode === 'notfound' || row.errorCode === 'notdir' ? 'not_found' : row.errorCode === 'timeout' ? 'failed' : 'read_only', status, errorWords(...))` with status 404/504/409; ready → entries from `answer.entries`: `{ name, kind: e.dir ? 'dir' : 'file', path: netPath(t.id, ...segs, e.name), size: e.dir ? null : e.size, date: e.date, protection: protectionString(e.protection), comment: e.comment || null, marks: [] }`. Crumbs: `NET:` › board name (`NET:/<id>`) › `<volume>:` (`NET:/<id>/<volume>`) › each drawer. `meta`: the remembered vols answer's free space for this volume (via `latestFor(…'vols'…)`, ready only) as `${(free/MB).toFixed(1)} MB free`, else `''`. `writable: false`, `readOnlyReason: 'Read-only for now'`.
- `remove`: accept `NET:/<board>/Queue/<id>` (3 segments) and the old 2-segment form.
- `write`: the copy-into destination becomes `NET:/<board>/Queue` (3rd segment `Queue`) or the old `NET:/<board>`; a volume path → `refuse('read_only', 409, 'Read-only for now')`.
- In the list route: `const fresh = url.searchParams.get('fresh') === '1'`; pass `{ fresh }`; catch `Pending` → `Response.json({ pending: true, label: e.label }, { status: 202, headers: { 'cache-control': 'no-store' } })`. `maxDuration` stays 60.
- `filesHrefForBoard` → ``NET:/${deviceId}/Queue``. `netPollMs`: `segments.length === 2 && segments[1] === QUEUE_FOLDER`.
- Grep for other builders of `NET:/<id>` strings (`grep -rn "NET:/\${" src`) — `send-drop-zone.tsx` reads `NET:/${board}` for the queue: change to `/Queue`.

- [ ] **Step 4: Run to see them pass** — Step 2 command. Expected: PASS. Then `pnpm vitest run src/lib/files` (whole folder) and `pnpm exec tsc --noEmit` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/net-driver.ts src/lib/files/driver.ts src/lib/files/types.ts src/lib/files/path.ts src/lib/files/net-rules.ts src/app/api/files/list/route.ts src/lib/send-targets.ts src/lib/send-ui.ts src/components/files/send-drop-zone.tsx src/lib/files/*.test.ts
git commit -m "NET: volumes: a board lists its Amiga's volumes and a Queue folder; drawers list through remote requests"
```

---

### Task 6: Copy out of a volume (server)

**Files:**
- Create: `src/lib/files/net-fetch.ts`, `src/lib/files/net-fetch.db.test.ts`, `src/app/api/files/net/fetch/[id]/route.ts`
- Modify: `src/lib/files/ops.ts` (dispatch), `src/lib/amiga-uploads.ts` (`openUpload` with request; `closeUpload` placement), `src/app/api/device/upload/route.ts` (body `request`), `src/app/api/device/upload/[id]/close/route.ts` (calls placement after a stored close), `src/lib/files/driver.ts` (`Outcome` gains `fetching?: { id: string; files: number }`), `src/lib/files/ops.ts` (`OpResult` passes `fetching` through)

**Interfaces:**
- Consumes: Task 3 `addGets`, `latestFor`, `getForUpload`, `settleGet`, `expireStale`; Task 5 path forms; `addUploadToLibrary(orgId, id)`, `addGameToCollection(orgId, collectionId, gameId)`, `libraryEligible(path, size)`, `uniqueStashPath`, `listStash`, `lockOrg`, `touchStashDirs`, `shelfDest(ctx, p)`.
- Produces:
  - `isNetVolumePath(p: FsPath): boolean` (3+ segments, second not `Queue`), exported from `net-driver.ts`.
  - `startFetch(ctx: OpCtx, req: CopyMove): Promise<Outcome>` — returns `{ kind: 'done', items, fetching: { id, files } }` or clashes.
  - `fetchProgress(db, orgId, fetchId, now): Promise<{ total: number; done: number; failed: { name: string; reason: string }[]; waiting: number; board: string; arrived: string[] } | null>` — `arrived`: the STASH: paths (`STASH:/…`) of the done files, from their upload rows.
  - `placeFetched(db, uploadId, now): Promise<void>` — called by the close route after a stored close of an upload with a request.
  - `GET /api/files/net/fetch/<id>` → 200 the progress (org-scoped), 404 otherwise.

- [ ] **Step 1: Write the failing DB tests** (`net-fetch.db.test.ts`), seeding a browsable board as in Task 5 and a remembered `dir` answer for `Work:` (entries `a.lha` 1000 bytes, `Games.adf` 901120 bytes, drawer `Sub`) and for `Work:Sub` (entry `b.txt` 10 bytes):
  - copy `NET:/<b>/Work/a.lha` + `NET:/<b>/Work/Sub` to `STASH:/In` (onClash keep-both) → `fetching.files === 2`; two `get` rows with targets `rel ['a.lha']` and `rel ['Sub','b.txt']`, dest `STASH:/In`; `reqVersion` bumped once.
  - a drawer with no remembered answer → refused `conflict`, detail `List the drawer again and retry`.
  - 65 files, or 17 MB, or a 5 MB file → refused `too_large` (detail names the limit or the file); nothing inserted.
  - Move from a volume → refused `read_only`, `Read-only for now`.
  - copy to LIBRARY: of `Games.adf` → one get with `library: { collectionId: null }`, `dest: 'STASH:'`; `a.lha` to LIBRARY: → that item refused `not_a_disk_image`, the other still queued.
  - onClash `ask` with `STASH:/In/a.lha` existing → `{ kind: 'clashes', clashes: [{ source: 'NET:/<b>/Work/a.lha', name: 'a.lha', dest: 'STASH:/In' }] }`; nothing inserted. `skip` → a.lha not fetched; `replace` → its target `replace: true`.
  - **Placement:** take the get (`takeWaiting`), answer `GOT <rid> 7` (`answerPiece`), `openUpload(db, dev, {…path:'Work:a.lha'…, request: rid})` → the upload row's `path` is `In/a.lha`, `source` `copy`, and the get's `uploadId` set; store the chunk and `closeUpload` with the right CRC, then `placeFetched` → the get is `done`; `listStash` shows `In/a.lha`. With `replace: true` and an existing `In/a.lha` → the old row is `deleted` and the new one holds the path. With keep-both → `In/a_2.lha` (whatever `uniqueStashPath` names).
  - Placement into LIBRARY: (`Games.adf` bytes = a blank ADF from `src/lib/blank-disk.ts`) → the get is `done`, `addUploadToLibrary` ran (the row's `libraryDiskId` set); with a collection target the title is in that collection.
  - Area full (seed the org's `amiga_uploads` to `UPLOAD_AREA_MAX_FILES`): `openUpload` with the request → `{ ok:false, code:'full' }` and the get is `failed` with text "STASH: is full"; the other gets are untouched.
  - `fetchProgress` → total, done, failed (with names = last `rel` segment), waiting, arrived (`['STASH:/In/a.lha']`); another org → null.
  - A get `sent` 601 s ago → `fetchProgress` counts it failed with reason `<board> stopped answering`.

- [ ] **Step 2: Run to see them fail** — `pnpm test:db src/lib/files/net-fetch.db.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `ops.ts` dispatch, `case 'copy': case 'move':` — a NET volume source is checked FIRST, before `shelfDest`'s filing (titles are never in NET:, and a disk image copied onto LIBRARY: from a volume is a fetch, not filing): `if (req.sources.some((s) => { const p = parsePath(s); return !!p && isNetVolumePath(p); })) return startFetch(ctx, req as CopyMove);`
  - `startFetch`: all sources must be on one board and be volume paths (else `unsupported`, "Copy from one board at a time"); `op === 'move'` → `refuse('read_only', 409, 'Read-only for now')`. Destination: `STASH:` path (any folder) → `library: null`, dest = that path; LIBRARY: root or a collection (via `shelfDest`; level `title` → `unsupported` "Copy onto LIBRARY: or a collection") → `library: { collectionId }`, dest `STASH:`; anything else → `unsupported` ("Copy to STASH: or LIBRARY:"). Expand: for each source, find its entry in its parent's remembered `dir` answer (`latestFor(…'dir', parentAmigaPath)` ready, else `conflict`); a drawer expands recursively through remembered answers of each sub-drawer (missing → `conflict` "List the drawer again and retry"). Files carry `rel` = [picked entry name, …sub path]. Limits (64 / 16 MB / 4 MB per file) → `too_large`. LIBRARY: per source: a drawer or a non-`libraryEligible` file → that item `{ ok:false, refusal:{ code:'not_a_disk_image' } }`. Clashes (STASH: dest only): names of tops against `listStash` rows directly in the dest folder (`sameStashName`), per P4. Insert gets via `addGets` with one `fetchId = newRequestId()`. Return `{ kind: 'done', items, fetching: { id: fetchId, files: n } }`.
  - `openUpload` gains `request?: string` in `OpenInput`. With it: `getForUpload(db, dev.deviceId, request)`; none → `{ ok:false, code:'name' }` (400); its target decides the stored path: `[...destSegments, ...rel].join('/')` where destSegments are the STASH: path's segments (STASH root: `rel` only); `source: 'copy'`, `deviceName: null`; set the get's `uploadId`. The org-area check stays (Review Focus 5): when `full`, `settleGet(db, rid, { ok:false, code:'full', text:'STASH: is full' })`. Resume matching still works (same path, size, date).
  - The upload route's zod body gains `request: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional()`.
  - `closeUpload` stores as today (its `uniqueStashPath` keep-both covers new clashes). `replace` is honoured in `closeUpload`'s transaction: when the row has a get with `target.replace` (look it up by `uploadId`), mark an existing *file* row at exactly `r.path` (`status: 'deleted'`) before computing `uniqueStashPath`. Keep it small: pass a `replace` flag read inside the same transaction.
  - `placeFetched(db, uploadId)`: the get by `uploadId`; library target → `addUploadToLibrary(orgId, uploadId)`; ok and `collectionId` → `addGameToCollection`; failure → `settleGet(failed, code, words)`; else `settleGet(ok)`. The close route calls it after a `{ ok: true }` close (await it; errors are caught and settle the get failed `io`).
  - A crc failure on close → `settleGet(rid, failed 'crc', 'the copy arrived damaged')`.
  - `fetchProgress`: `expireStale` first; rows by `fetchId` and `orgId`.

- [ ] **Step 4: Run to see them pass** — Step 2 command, plus `pnpm test:db src/lib/amiga-uploads` (existing upload tests stay green) and `pnpm test:db src/app/api/device/upload`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/files/net-fetch.ts src/lib/files/net-fetch.db.test.ts src/app/api/files/net src/lib/files/ops.ts src/lib/files/driver.ts src/lib/amiga-uploads.ts src/app/api/device/upload
git commit -m "NET: volumes: copy out of a volume -- one get per file, placed in STASH: or the library as it arrives"
```

---

### Task 7: The pane — pending listings, Refresh, read-only, labels

**Files:**
- Modify: `src/components/files/files-manager.tsx` (`fetchListing` ~line 209, navigation ~366/456, reasons ~667-700, keys), `src/components/files/pane.tsx` (title bar, loading overlay, reason/cut rows), `src/lib/files/bank.ts`, `src/components/files/button-bank.tsx`, `src/lib/files/keys.ts`, `src/lib/files/pane-rules.ts`, `src/lib/files/net-rules.ts`
- Test: `src/lib/files/bank.test.ts`, `src/lib/files/net-rules.test.ts`, `src/lib/files/keys.test.ts`, `src/lib/files/pane-rules.test.ts`

**Interfaces:**
- Consumes: Task 5's 202 `{pending, label}`, `Listing.net`, kind `volume`.
- Produces (pure, in `net-rules.ts`): `isNetVolume(l: Listing | null): boolean`; `NET_READ_ONLY = 'Read-only for now'`; `readAgo(readAt: number | null, now: number): string | null` ("read 40 s ago", "read 2 min ago", null when null or under 5 s); `netTitle(l: Listing): string | null` (`A500 · Work:Programs`); `nextAsk(startedAt: number, now: number): 'ask' | 'give-up'` (give up at `PANE_GIVE_UP_MS`). Bank: `'refresh'` in `BankCommand`, `BANK_GRID[16] = 'refresh'`, label `Refresh`. Keys: `Ctrl-R`/`Meta-R` → `'refresh'`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// bank.test.ts (add)
it('Refresh takes the empty cell before Delete', () => {
  expect(BANK_GRID[16]).toBe('refresh');
  expect(BANK_GRID.filter((c) => c === null)).toHaveLength(0);
  expect(BANK_LABEL.refresh).toBe('Refresh');
});
// net-rules.test.ts (add)
it('readAgo', () => {
  expect(readAgo(null, 1000)).toBeNull();
  expect(readAgo(1000, 3000)).toBeNull();
  expect(readAgo(0, 40_000)).toBe('read 40 s ago');
  expect(readAgo(0, 125_000)).toBe('read 2 min ago');
});
it('nextAsk gives up after 20 s', () => {
  expect(nextAsk(0, 19_999)).toBe('ask');
  expect(nextAsk(0, 20_000)).toBe('give-up');
});
it('netTitle', () => {
  expect(netTitle({ net: { board: 'd', boardName: 'A500', volume: 'Work', amigaPath: 'Work:Programs', readAt: null, cut: false, browse: null } } as never)).toBe('A500 · Work:Programs');
});
// keys.test.ts (add)
it('Ctrl-R and Cmd-R refresh', () => { /* follow the file's existing key-event helper: ctrlKey r → 'refresh', metaKey r → 'refresh' */ });
```

And a `pane-rules.test.ts` case: on a volume listing (`net.volume` set), the reasons for move/delete/rename/makedir/protect/createadf/addlib are `Read-only for now`; copy/download/info are not refused for that reason (feed `commandReasons`-style function if one exists; otherwise test `netVolumeReason(l)` → `'Read-only for now'` and `copyOutReason(volumeListing)` → `null`). `copyOutReason` must keep refusing `NET:/<b>/Queue` (R5) but not volumes.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run src/lib/files`. Expected: FAIL on the new cases.

- [ ] **Step 3: Implement.**
  - `fetchListing(path, fresh = false)`: URL gets `&fresh=1` when fresh; a 202 → `{ pending: label }`. Callers (navigate, reload) loop: keep the pane's previous listing, set `pending: label` on the pane state (new field `pending: string | null` in `PaneState`), then re-ask every `PANE_ASK_MS` (without fresh) until a listing, an error, `nextAsk` → give-up (error `${boardName} didn't answer — Refresh to try again`, board name from the old listing's `net.boardName` or the path's board segment), or the pane navigated elsewhere (compare a per-pane request token held in a ref; a stale loop stops silently).
  - `pane.tsx`: while `pending`, the rows render with `opacity-50` and a one-line status above them reading the label (`data-testid="pane-pending"`); the title bar shows `netTitle(l)` (in place of the path text) when `l.net?.amigaPath` and `readAgo(l.net.readAt, now)` after it when non-null; the board root with `net.browse` shows one row `data-testid="net-browse-reason"` with those words above Queue; `net.cut` adds a final non-selectable row `Only the first 1000 entries are shown`. Kind `volume` renders as a folder (icon and open behaviour as `dir`).
  - Reasons: with `isNetVolume(src)` → move/delete/rename/makedir/protect/createadf/addlib = `NET_READ_ONLY`; `copyOutReason` returns null for volume listings. Destination checks: `acceptsCopies(volumeListing)` false with `NET_READ_ONLY` as the reason. On the board root (volumes + Queue), commands act as on a folder list: copy/move refused `Open a volume or Queue`.
  - Refresh: `bankReasons.refresh = null` whenever the pane has a path; action = reload the source pane with `fresh` (on non-NET panes it is the normal reload). Phone sheet: a `PhoneButton id="refresh"`. Key `refresh` → same action; prevent the browser's reload.
  - Drag out of a volume pane: allowed as copy (the drop path calls the same copy op); dropping onto a volume pane is refused with `Read-only for now` (the drop handler's existing refusal path).

- [ ] **Step 4: Run** — `pnpm vitest run src/lib/files src/components/files && pnpm exec tsc --noEmit`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/files src/lib/files
git commit -m "Files: NET: volumes in the pane -- pending listings, Refresh (button, Ctrl-R), read-only reasons, read N s ago"
```

---

### Task 8: The pane — copy out, progress, Download

**Files:**
- Modify: `src/components/files/files-manager.tsx` (the copy action, status row, download), `src/lib/files/manager-rules.ts` (progress words)
- Test: `src/lib/files/manager-rules.test.ts`

**Interfaces:**
- Consumes: Task 6 `fetching` in the op result; `GET /api/files/net/fetch/<id>`.
- Produces (pure, `manager-rules.ts`): `fetchStatus(p: { total: number; done: number; failed: { name: string; reason: string }[]; waiting: number }, board: string): { line: string; finished: boolean }` — running: `Copying ${done + failed.length + 1} of ${total} from ${board}…` (capped at total); finished: `Copied ${done}` plus `, ${failed.length} failed: ${name}: ${reason}` (first failure named, `; …` when more).

- [ ] **Step 1: Failing tests**

```ts
it('fetchStatus counts up and ends with a summary', () => {
  expect(fetchStatus({ total: 12, done: 2, failed: [], waiting: 10 }, 'A500')).toEqual({ line: 'Copying 3 of 12 from A500…', finished: false });
  expect(fetchStatus({ total: 12, done: 11, failed: [{ name: 'x.lha', reason: 'Object not found' }], waiting: 0 }, 'A500'))
    .toEqual({ line: 'Copied 11, 1 failed: x.lha: Object not found', finished: true });
  expect(fetchStatus({ total: 2, done: 2, failed: [], waiting: 0 }, 'A500')).toEqual({ line: 'Copied 2', finished: true });
});
```

- [ ] **Step 2: Run to fail** — `pnpm vitest run src/lib/files/manager-rules.test.ts`.

- [ ] **Step 3: Implement.**
  - Before posting a copy whose source pane is a volume: for each picked drawer, walk it with the Task 7 pending loop using `fresh` for the drawer itself and its sub-drawers (status row: the pending label), collecting nothing client-side — the walk only makes sure the server remembers every drawer (P3). Abort with the loop's error words on failure. Then post the normal copy op.
  - An op result with `fetching` → status row polls `/api/files/net/fetch/<id>` every 1 s and shows `fetchStatus(...).line`; on finished, the line stays as the op's result message and the destination pane reloads. The busy lock (`oneAtATime`) is held only while posting, not while fetching (the person may keep browsing); a second copy out while one runs is allowed (they queue on the board).
  - Download on a volume file: post a copy to `STASH:` (onClash keep-both) of that one file; when its fetch finishes ok, take `arrived[0]` from the progress and start the existing STASH: download for that path. On failure, the status row shows the reason.
  - Info on a volume row: the existing Info dialog with size, date, protection, comment from the row.

- [ ] **Step 4: Run** — `pnpm vitest run src/lib/files src/components/files && pnpm exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/files src/lib/files
git commit -m "Files: copy and download out of NET: volumes, with progress from the board"
```

---

### Task 9: Fake board, e2e, help, HANDOFF

**Files:**
- Modify: `e2e/amiga-board.ts`, `e2e/device-helpers.ts` (a `setBrowse` seed), `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`, `HANDOFF.md`, existing NET e2e specs that open `NET:/<board>` for the queue (`grep -rln "NET:/" e2e` — `files-net.spec.ts`, `files-net.mobile.spec.ts`, `send-to-amiga.spec.ts` …) → `/Queue`
- Create: `e2e/files-net-volumes.spec.ts`, `e2e/files-net-volumes.mobile.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (e2e helpers):
  - `setBrowse(deviceId, o: { firmware?: string; rx?: 'c'|'u'; rxProto?: 2|3; browseOn?: boolean })` — direct DB update (as `seedDevices` does), setting `lastSeenAt: now`, `sendRxAt: now`.
  - `boardTakesRequests(request, token): Promise<{ id: string; kind: 'VOLS'|'DIR'|'GET'; path: string }[]>` — `GET /api/device/req`, parses Latin-1 lines.
  - `boardAnswers(request, token, rid, lines: string[], piece = 0, last = true)` — POST with `amigaJson` body.
  - `boardServes(request, token, fs: Record<string, FakeEntry[]>, until: () => boolean)` — a loop (every 300 ms, stops when `until()` or after 30 s) that takes requests and answers VOLS (from `fs['']` volumes), DIR (from `fs[path]`, ERR notfound when missing), GET (GOT, then `boardUploads(…)` with `request` in the open body — extend `boardOpens` with an optional `request`).

- [ ] **Step 1: Help.** Add to the `files` topic a section "Browsing the Amiga" (words, keep the topic's style): needs firmware 1.22 and Transfer 2.3 with browsing switched on in Transfer; each drawer takes a few seconds; a drawer read in the last 2 minutes opens at once and says when it was read; Refresh (or Ctrl-R) reads it again; read-only for now — copy files to STASH: or disk images to LIBRARY:; the send queue is in each board's Queue folder. Add a `topics.test.ts` case that the files help mentions `Refresh` and `Queue` and does not say the Amiga's disks can be written.

- [ ] **Step 2: Write the e2e specs** (desktop), each test signing up fresh and pairing a board as `files-net.spec.ts` does, then `setBrowse(id, { firmware: '1.22.0', rx: 'c', rxProto: 3, browseOn: true })`:
  1. Volumes: open `/files?left=STASH:&right=NET%3A%2F<id>&active=right`; while `pane-pending` shows `Reading volumes from`, `boardServes` answers volumes Work (DH1:) and Workbench (DH0:); rows Work, Workbench, Queue appear; `Work` row shows `DH1: ·`.
  2. Drawer + memory + Refresh: open Work → `Programs` row; open it, Parent → listing appears without a new request (assert `boardTakesRequests` returns `[]` right after Parent), title shows `read`; press the bank's Refresh → `pane-pending` shows again and a new DIR is served.
  3. Copy to STASH: pick `a.lha` in Work, left pane STASH:, Copy → status row `Copying 1 of 1 from`, then `Copied 1`; STASH: lists `a.lha`.
  4. ADF to LIBRARY: copy `Blank.adf` (a blank ADF from `e2e` fixtures or `createAdf` bytes) from Work to LIBRARY: → `Copied 1`; LIBRARY: lists a new title.
  5. Browsing off: `setBrowse(id, { browseOn: false })`; the board root shows `net-browse-reason` "Switch on browsing in Transfer on" and Queue; Queue opens and lists the send queue.
  6. No answer: open a volume and never serve → after 20 s the pane shows `didn't answer — Refresh to try again` (use `expect(...).toBeVisible({ timeout: 25_000 })`).
  7. Read-only: on a volume, the bank's Delete, Move, Rename, Makedir are `aria-disabled` with `Read-only for now`.
  Mobile spec: tests 1, 3 and 7 with the phone sheet (Copy to… picker, Refresh in the sheet).

- [ ] **Step 3: Update the existing NET e2e specs** to the `/Queue` path wherever they open or assert the queue path.

- [ ] **Step 4: Run**

Run (each foreground, under 9 min; split if longer):
`PORT=3100 bash scripts/e2e-local.sh e2e/files-net-volumes.spec.ts --project=desktop`
`PORT=3100 bash scripts/e2e-local.sh e2e/files-net-volumes.mobile.spec.ts --project=mobile`
`PORT=3100 bash scripts/e2e-local.sh e2e/files-net.spec.ts e2e/send-to-amiga.spec.ts e2e/from-amiga.spec.ts --project=desktop`
`PORT=3100 bash scripts/e2e-local.sh e2e/files-net.mobile.spec.ts --project=mobile`
`pnpm vitest run src/lib/help`
Expected: all PASS. Report any failure by name with its output; a failure that also fails on master is noted as such, not hidden.

- [ ] **Step 5: HANDOFF.** Add an entry §4-net-volumes: server/web step merged (commit), migration 0053, inert until firmware 1.22 sends `reqAck`; next: Transfer 2.3 plan, firmware 1.22 plan, the bench (spec §7). Update §4's Current order line accordingly.

- [ ] **Step 6: Commit**

```bash
git add e2e/amiga-board.ts e2e/device-helpers.ts e2e/files-net-volumes.spec.ts e2e/files-net-volumes.mobile.spec.ts e2e/files-net.spec.ts e2e/files-net.mobile.spec.ts e2e/send-to-amiga.spec.ts src/lib/help/topics.tsx src/lib/help/topics.test.ts HANDOFF.md
git commit -m "NET: volumes: fake-board e2e, help, HANDOFF"
```

(Stage only the e2e files you actually changed.)
