# Progress Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible "Transfers" panel on every page that shows each running Files job the board carries out (copies and moves to and from the Amiga, writes on its volumes, plain Queue sends) with a bar by bytes, counts, a rolling time-left estimate and "Cancel the rest"; Files' bottom-bar line for NET: jobs goes away.

**Architecture:** The server is the record: `GET /api/files/jobs` lists the org's running jobs (and those finished in the last 2 minutes) computed from `transfers`, `remote_requests` and `amiga_uploads` — no migration — reusing `fetchProgress`; `POST /api/files/jobs/<id>/cancel` withdraws or stops what has not gone, per kind. A client-safe view model turns a job into card words; a framework-free client store polls only while a job runs and is shared by the panel (mounted in the app layout) and Files (which tells it about a job it just started and listens to it to refresh its panes).

**Tech Stack:** Next.js 16.3.2 App Router (route handlers, a client component in the `(app)` layout), React 19.2 (`useSyncExternalStore`), drizzle-orm on plain Postgres, vitest 4 (unit and `test:db`), Playwright (e2e with the fake board in `e2e/amiga-board.ts`), sonner, the shared `Modal` (Base UI Dialog).

**Spec:** `docs/superpowers/specs/2026-11-01-progress-panel-design.md` (approved by the operator; the binding authority). Read it fully before any task.

## Global Constraints

- The spec is binding. Words it quotes are used verbatim: region name **"Transfers"**; button **"Cancel the rest"**; confirm **"Cancel the rest of this copy? What has arrived stays."**; **"Waiting for <board> (offline)"**; pill **"1 job · 41 %"** / **"2 jobs · 41 %"**; card line **"3 of 12 files · 2.4 of 9.8 MB · about 1 min left"**; titles **"Copying to <board> · <place>"**, **"Copying from <board> to STASH:"**, **"Deleting <label> on <board>"**, **"Sending 3 files to <board>"**; cancelled move **"Cancelled: 5 of 12 moved; the rest is still in <source>"**; failures: first five, then **"and N more"**.
- Timings from the spec, exactly: estimate after **10 s** of progress, rolling over the last **30 s** of bytes; clean finish fades after **6 s**; server keeps finished jobs **2 minutes**; polling **2 s** while visible, **15 s** while the board it waits on is offline, **none** while the tab is hidden, **none** when nothing runs.
- Self-host parity (operator rule): plain Postgres queries only; no hosted-only service (no Vercel KV/queues/websockets/cron for this). The panel polls our own route.
- No new DB migration. Everything is computed from `transfers`, `remote_requests`, `amiga_uploads`. Two additions are data, not schema: an optional `size` in the `remote_requests.target` jsonb of a get (written at the start of a copy, so bytes are known before each upload opens), and a `remote_requests` row of kind `'cancel'` (a text column) recording that a job was cancelled and what a cancelled move keeps. If a task finds it truly needs a migration, stop and ask; do not add one.
- Next.js here is 16.3.2 and differs from training data: read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (route handler `params` is a `Promise`) and `layout.md` (a layout keeps its state across navigations) before Tasks 2, 3 and 5. Follow the existing route pattern (`src/app/api/files/net/fetch/[id]/route.ts`).
- Help text changes with the behaviour it describes (`src/lib/help/topics.tsx`); `src/lib/help/topics.test.ts` enforces word budgets (files ≤ 415 words, others ≤ 280; `send` is at 280 already) and bans the words `PSRAM|TBYB|poll|sha256|cursor|WPROT`.
- Lint: the repo runs `react-hooks/set-state-in-effect`; never call a state setter synchronously in an effect body (from a timer, rAF, listener or store callback is fine). Browser storage is read and written only inside `try/catch`, and the page works without it.
- The app has one (light) theme; use the existing tokens (`--surface`, `--surface-2`, `--track`, `--line`, `--ink`, `--muted`). Dialogs are `z-50`; the panel is `z-30` and must never cover a dialog. Touch targets ≥ 44 px below `lg`.
- Unit tests: `pnpm vitest run <path>`. Typecheck: `pnpm exec tsc --noEmit`. Lint: `pnpm exec eslint <files>`.
- DB tests: `TEST_DATABASE_URL=$(WEBADF_PG_NAME=webadf-pg-e2e WEBADF_PG_PORT=55433 bash scripts/dev-db.sh start) pnpm test:db <path>`. Never point any test at production or at `.env.local`'s `DATABASE_URL`.
- e2e: only `PORT=3100 bash scripts/e2e-local.sh <specs> --reporter=line`, in the foreground, each run under 9 minutes (split a long spec with `-g`), only the specs for the touched areas, never two e2e runs at once and not while `test:db` runs (they share the `webadf-pg-e2e` container). Never `pkill` by pattern; stop only your own PIDs.
- Git: commit on the working branch the controller gives you; never `git stash`; never `git add -A` or `git add .`; add files by name; re-run `git status` before staging (other sessions change this tree; never stage anything under `wifi-floppy/` or the untracked files at the repo root). Commit messages plain, no trailers or attribution lines.
- The A500 bench (spec §7: the Monkey Island case, four disks' files to Work:, watched in the panel, Cancel halfway) is the operator's step, run by the controller after the branch is merged — not a task here.

## Review Focus

1. **A job whose files are all empty (0 bytes)** — a reasonable person expects a bar that still moves by files and a line without "0 of 0 KB" or "NaN %". Test added to Task 1 (`barOf`/`jobLine` with `bytes: { total: 0, done: 0 }`).
2. **Two jobs at once** — cancelling one must leave the other running untouched, and the pill must sum both. Tests added to Task 3 (isolation DB test) and Task 1 (`pillWords` over two jobs).
3. **Cancel that races the job's own end, or pressed twice** — expected: no error, nothing cancelled, no second marker, and a job that finished on its own never reads "Cancelled:". Tests added to Task 3.
4. **A file arriving from the Amiga at the moment of Cancel** — expected: its upload stops (the board's next chunk hears 404), a get the board took but has not opened is refused at open, and nothing half-arrived lingers in STASH:. Test added to Task 3.
5. **Browser storage that throws (private window) and a tab hidden then shown** — expected: the panel still works with defaults, and on return asks once at once rather than waiting. Tests added to Task 4.

---

## File Structure

- Create `src/lib/files/job-view.ts` — CLIENT-SAFE: the `JobView` type the server sends, constants shared by server and client (`JOB_SHOWN_MS`, `QUEUE_JOB`, `CANCEL_KIND`, `CANCELLED`, `FADE_MS`, `WARMUP_MS`, `WINDOW_MS`), and the pure card rules (title, line, bar, estimate, pill, result, failures, fade/keep, confirm words, `commonDrawer`, `panelLift`).
- Modify `src/lib/files/manager-rules.ts` — export `JobWriteView`, `JobProgressView`, `RUNNING_WORDS`; extract `runningWriteLine` (no behaviour change).
- Modify `src/lib/remote-requests.ts` (GetTarget gains `size?`), `src/lib/files/net-fetch.ts` (writes it).
- Create `src/lib/files/jobs.ts` — SERVER: `listJobs` (Files jobs + synthetic Queue jobs, bytes, title parts).
- Create `src/app/api/files/jobs/route.ts` — `GET`.
- Modify `src/lib/transfers.ts` — `cancelQueueSends`.
- Create `src/lib/files/job-cancel.ts` — SERVER: `cancelJob` per kind.
- Create `src/app/api/files/jobs/[id]/cancel/route.ts` — `POST`.
- Create `src/lib/files/jobs-client.ts` — CLIENT-SAFE store: polling cadence, track/watch, samples, seen/open memory, announcements.
- Create `src/components/shell/jobs-provider.tsx` — the store in React context.
- Create `src/components/shell/transfers-panel.tsx` — the panel.
- Modify `src/app/(app)/layout.tsx`, `src/app/globals.css`, `src/components/ui/sonner.tsx`.
- Modify `src/components/files/files-manager.tsx`, `src/components/files/button-bank.tsx`.
- Modify `src/lib/help/topics.tsx`, `src/lib/help/topics.test.ts`.
- Tests: `src/lib/files/job-view.test.ts`, `src/lib/files/manager-rules.test.ts`, `src/lib/files/jobs.db.test.ts`, `src/lib/files/job-cancel.db.test.ts`, `src/lib/files/jobs-client.test.ts`, `src/lib/files/net-fetch.db.test.ts`, `e2e/transfers-panel.spec.ts`, `e2e/files-net-writes.spec.ts`, `e2e/files-net-volumes.spec.ts`, `e2e/files-net-volumes.mobile.spec.ts`, `e2e/amiga-board.ts`.

---

### Task 1: The card's view model (pure, client-safe)

**Files:**
- Modify: `src/lib/files/manager-rules.ts:150-205` (types, `RUNNING`, `jobLine`)
- Create: `src/lib/files/job-view.ts`
- Test: `src/lib/files/manager-rules.test.ts` (add a `describe`), `src/lib/files/job-view.test.ts` (new)

**Interfaces:**
- Consumes: `jobStatus(p: JobProgressView, board: string): { line: string; finished: boolean }` (existing).
- Produces (later tasks rely on these exact names):
  - from `manager-rules.ts`: `export type JobWriteView`, `export type JobProgressView`, `export const RUNNING_WORDS: Record<string, string>`, `export function runningWriteLine(p: JobProgressView, board: string): string | null`.
  - from `job-view.ts`: `JobKind`, `JobView`, `Sample = { at: number; done: number }`, constants `JOB_SHOWN_MS = 120_000`, `QUEUE_JOB = 'queue:'`, `CANCEL_KIND = 'cancel'`, `CANCELLED = 'cancelled'`, `FADE_MS = 6_000`, `WARMUP_MS = 10_000`, `WINDOW_MS = 30_000`, `FAILED_SHOWN = 5`; functions `commonDrawer(paths: string[]): string | null`, `jobTitle(j)`, `sizeWords(done, total)`, `leftWords(sec)`, `itemsOf(j)`, `barOf(j): { value: number; byBytes: boolean }`, `timeLeft(samples, j, now): number | null`, `jobLine(j, left: number | null)`, `jobNow(j): string | null`, `resultWords(j)`, `failureList(j): string[]`, `isClean(j)`, `cardShown(j, { finishedSeenAt: number | null; dismissed: boolean; now: number })`, `pillWords(jobs)`, `canCancel(j)`, `confirmWords(j)`, `panelLift(anchorTops: number[], viewport: number): number`.

- [ ] **Step 1: Write the failing test for `runningWriteLine`**

Append to `src/lib/files/manager-rules.test.ts` (and add `runningWriteLine` to its import list from `./manager-rules`):

```ts
// Progress panel (spec 2026-11-01 §3): the write a job runs now, as the card's second line says it.
describe('runningWriteLine', () => {
  type W = Parameters<typeof jobStatus>[0]['writes'][number];
  const w = (o: Partial<W>): W => ({ kind: 'delete', label: 'Work:Big', to: null, status: 'running', removed: 0, reason: null, entry: null, quiet: false, ...o });
  const p = (writes: W[], waiting = 0): Parameters<typeof jobStatus>[0] => ({ total: 0, done: 0, failed: [], waiting, skipped: 0, writes, direction: 'to' });
  it('a running delete with how far it got', () => {
    expect(runningWriteLine(p([w({ removed: 50 })]), 'A500')).toBe('Deleting Work:Big on A500… removed 50 so far');
  });
  it('a waiting write once no file waits', () => {
    expect(runningWriteLine(p([w({ status: 'waiting' })]), 'A500')).toBe('Deleting Work:Big on A500…');
  });
  it('none while files still wait, or when only quiet writes run', () => {
    expect(runningWriteLine(p([w({ status: 'waiting' })], 2), 'A500')).toBeNull();
    expect(runningWriteLine(p([w({ quiet: true })]), 'A500')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/files/manager-rules.test.ts`
Expected: FAIL — `runningWriteLine` is not exported.

- [ ] **Step 3: Refactor `manager-rules.ts` (no behaviour change)**

In `src/lib/files/manager-rules.ts`:
1. Change `type JobWriteView = {` to `export type JobWriteView = {`.
2. Replace `const RUNNING: Record<string, string> = {` with `export const RUNNING_WORDS: Record<string, string> = {` (same entries).
3. Change `type JobProgressView = {` to `export type JobProgressView = {`.
4. Add, directly above `function jobLine(`:

```ts
/**
 * The write a job runs now, in words ("Deleting Work:old on A500… removed 37 so far"): the loud write on its way, or
 * -- once no file waits -- the next loud one. Null when none: the progress panel's second line then names the file.
 */
export function runningWriteLine(p: JobProgressView, board: string): string | null {
  const loud = p.writes.filter((w) => !w.quiet);
  const running = loud.find((w) => w.status === 'running') ?? (p.waiting === 0 ? loud.find((w) => w.status === 'waiting') : undefined);
  if (!running) return null;
  const so = running.kind === 'delete' && running.removed > 0 ? ` removed ${running.removed} so far` : '';
  return `${RUNNING_WORDS[running.kind] ?? 'Changing'} ${running.label} on ${board}…${so}`;
}
```

5. In `jobLine`, replace its first block

```ts
  const loud = p.writes.filter((w) => !w.quiet);
  const running = loud.find((w) => w.status === 'running') ?? (p.waiting === 0 ? loud.find((w) => w.status === 'waiting') : undefined);
  if (running) {
    const so = running.kind === 'delete' && running.removed > 0 ? ` removed ${running.removed} so far` : '';
    return { line: `${RUNNING[running.kind] ?? 'Changing'} ${running.label} on ${board}…${so}`, finished: false };
  }
```

with

```ts
  const loud = p.writes.filter((w) => !w.quiet);
  const running = runningWriteLine(p, board);
  if (running) return { line: running, finished: false };
```

(`loud` is still used further down in `jobLine`.)

- [ ] **Step 4: Run the manager-rules tests**

Run: `pnpm vitest run src/lib/files/manager-rules.test.ts`
Expected: PASS (the new describe and every existing `jobStatus` test).

- [ ] **Step 5: Write the failing tests for the view model**

Create `src/lib/files/job-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  barOf, canCancel, cardShown, commonDrawer, confirmWords, failureList, isClean, jobLine, jobNow, jobTitle, leftWords, panelLift,
  pillWords, resultWords, sizeWords, timeLeft, type JobView, type Sample,
} from './job-view';

const KB = 1024;
const MB = 1024 * 1024;
type W = JobView['writes'][number];
const w = (o: Partial<W> = {}): W => ({ kind: 'delete', label: 'Workbench:Old', to: null, status: 'waiting', removed: 0, reason: null, entry: null, quiet: false, ...o });
const job = (o: Partial<JobView> = {}): JobView => ({
  id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools', writeKind: null,
  total: 12, done: 3, failed: [], waiting: 9, skipped: 0, writes: [], offline: null, arrived: [],
  cancelled: 0, cancel: null, bytes: { total: Math.round(9.8 * MB), done: Math.round(2.4 * MB) }, current: 'Work:Tools/Disk1.adf', running: true,
  startedAt: '2026-11-01T10:00:00.000Z', finishedAt: null, ...o,
});
const done = (o: Partial<JobView> = {}) => job({ running: false, waiting: 0, current: null, finishedAt: '2026-11-01T10:01:00.000Z', ...o });

describe('jobTitle (spec §3)', () => {
  it('says what and where', () => {
    expect(jobTitle(job())).toBe('Copying to A500 · Work:Tools');
    expect(jobTitle(job({ kind: 'move' }))).toBe('Moving to A500 · Work:Tools');
    expect(jobTitle(job({ from: 'A1200' }))).toBe('Copying from A1200 to A500 · Work:Tools');
    expect(jobTitle(job({ direction: 'from', place: 'STASH:' }))).toBe('Copying from A500 to STASH:');
    expect(jobTitle(job({ kind: 'send', total: 3, place: null }))).toBe('Sending 3 files to A500');
    expect(jobTitle(job({ kind: 'send', total: 1, place: null }))).toBe('Sending 1 file to A500');
  });
  it('a write job: its one object, or how many', () => {
    expect(jobTitle(job({ kind: 'write', writeKind: 'delete', total: 0, writes: [w(), w({ label: 'Workbench:Old.info', quiet: true })] })))
      .toBe('Deleting Workbench:Old on A500');
    expect(jobTitle(job({ kind: 'write', writeKind: 'delete', total: 0, writes: [w(), w({ label: 'b' }), w({ label: 'c' })] }))).toBe('Deleting 3 items on A500');
    expect(jobTitle(job({ kind: 'write', writeKind: null, total: 0, writes: [w(), w({ kind: 'rename', label: 'b' })] }))).toBe('Changing 2 items on A500');
  });
});

describe('jobLine, sizeWords, leftWords', () => {
  it('files, bytes and the time left', () => {
    expect(jobLine(job(), 70)).toBe('3 of 12 files · 2.4 of 9.8 MB · about 1 min left');
    expect(jobLine(job(), null)).toBe('3 of 12 files · 2.4 of 9.8 MB');
  });
  it('an offline board: waiting, and no estimate', () => {
    expect(jobLine(job({ offline: 'A500' }), 70)).toBe('3 of 12 files · 2.4 of 9.8 MB · Waiting for A500 (offline)');
  });
  it('under a megabyte in KB', () => {
    expect(sizeWords(12 * KB, 820 * KB)).toBe('12 of 820 KB');
    expect(sizeWords(Math.round(2.4 * MB), Math.round(9.8 * MB))).toBe('2.4 of 9.8 MB');
  });
  it('time left in words', () => {
    expect(leftWords(8)).toBe('less than a minute left');
    expect(leftWords(70)).toBe('about 1 min left');
    expect(leftWords(200)).toBe('about 3 min left');
  });
  // Review Focus 1: only empty files -- by files, never "of 0 KB" or NaN.
  it('a job of empty files says no size and its bar goes by files', () => {
    const empty = job({ total: 2, done: 0, waiting: 2, bytes: { total: 0, done: 0 } });
    expect(jobLine(empty, null)).toBe('0 of 2 files');
    expect(barOf(empty)).toEqual({ value: 0, byBytes: false });
    expect(barOf({ ...empty, waiting: 1 })).toEqual({ value: 50, byBytes: false });
  });
  it('one file, one item', () => {
    expect(jobLine(job({ total: 1, done: 0, waiting: 1, bytes: { total: 4, done: 0 } }), null)).toBe('0 of 1 file · 0 of 1 KB');
    expect(jobLine(job({ kind: 'write', total: 0, bytes: null, writes: [w({ status: 'running' })] }), null)).toBe('0 of 1 item');
  });
});

describe('barOf', () => {
  it('by bytes where known, by items otherwise', () => {
    expect(barOf(job())).toEqual({ value: 24, byBytes: true });
    expect(barOf(job({ kind: 'write', total: 0, bytes: null, writes: [w({ status: 'done' }), w({ status: 'running' })] }))).toEqual({ value: 50, byBytes: false });
  });
});

describe('timeLeft (spec §3: after 10 s of progress, the last 30 s of bytes)', () => {
  const t0 = 1_000_000;
  const every2s = (n: number): Sample[] => Array.from({ length: n }, (_, k) => ({ at: t0 + k * 2000, done: k * 100_000 }));
  const j = job({ bytes: { total: 1_000_000, done: 600_000 } });
  it('a rolling estimate once warm', () => {
    expect(timeLeft(every2s(7), j, t0 + 12_000)).toBe(8);
  });
  it('not before 10 s of progress', () => {
    expect(timeLeft(every2s(6), j, t0 + 11_999)).toBeNull();
    expect(timeLeft([{ at: t0, done: 0 }, { at: t0 + 2000, done: 0 }], j, t0 + 20_000)).toBeNull();
  });
  it('samples older than 30 s do not count', () => {
    expect(timeLeft([{ at: t0 - 40_000, done: 0 }, ...every2s(7)], j, t0 + 12_000)).toBe(8);
  });
  it('none while the board is offline, nor once finished', () => {
    expect(timeLeft(every2s(7), { ...j, offline: 'A500' }, t0 + 12_000)).toBeNull();
    expect(timeLeft(every2s(7), { ...j, running: false }, t0 + 12_000)).toBeNull();
  });
});

describe('jobNow', () => {
  it('the file moving now, else the write running, else nothing', () => {
    expect(jobNow(job())).toBe('Work:Tools/Disk1.adf');
    expect(jobNow(job({ kind: 'write', total: 0, current: null, writes: [w({ label: 'Work:Big', status: 'running', removed: 50 })] })))
      .toBe('Deleting Work:Big on A500… removed 50 so far');
    expect(jobNow(job({ current: null }))).toBeNull();
    expect(jobNow(done())).toBeNull();
  });
});

describe('resultWords (today\'s finished line, and Cancel\'s)', () => {
  it('a finished copy says what jobStatus says', () => {
    expect(resultWords(done({ done: 12 }))).toBe('Copied 12 to A500');
    expect(resultWords(done({ done: 11, skipped: 1 }))).toBe('Copied 11 to A500, skipped 1 (already there)');
  });
  it('cancelled: how far it got, and for a move where the rest is', () => {
    expect(resultWords(done({ done: 5, cancelled: 7, cancel: { move: false, source: null } }))).toBe('Cancelled: 5 of 12 copied');
    expect(resultWords(done({ kind: 'move', done: 5, cancelled: 7, cancel: { move: true, source: 'STASH:/Games' } })))
      .toBe('Cancelled: 5 of 12 moved; the rest is still in STASH:/Games');
    expect(resultWords(done({ kind: 'write', total: 0, bytes: null, cancelled: 2, cancel: { move: false, source: null },
      writes: [w({ status: 'done' }), w({ status: 'failed', reason: 'cancelled' }), w({ status: 'failed', reason: 'cancelled' })] }))).toBe('Cancelled: 1 of 3 done');
  });
  it('a part cancelled elsewhere (a Queue Delete) is said apart', () => {
    expect(resultWords(done({ total: 3, done: 2, cancelled: 1 }))).toBe('Copied 2 to A500 · 1 cancelled');
  });
  it('plain sends', () => {
    expect(resultWords(done({ kind: 'send', total: 3, done: 3, place: null }))).toBe('Sent 3 files to A500');
    expect(resultWords(done({ kind: 'send', total: 3, done: 2, place: null, failed: [{ name: 'x.lha', reason: 'Transfer is not running' }] })))
      .toBe('Sent 2 files to A500, 1 failed: x.lha: Transfer is not running');
  });
});

describe('failureList', () => {
  it('the first five, then how many more', () => {
    const failed = Array.from({ length: 7 }, (_, k) => ({ name: `f${k}`, reason: 'r' }));
    expect(failureList(done({ failed }))).toEqual(['f0: r', 'f1: r', 'f2: r', 'f3: r', 'f4: r', 'and 2 more']);
    expect(failureList(done({ failed: failed.slice(0, 2) }))).toEqual(['f0: r', 'f1: r']);
  });
});

describe('isClean and cardShown (spec §3: a clean finish fades after 6 s, a failure stays)', () => {
  const now = 100_000;
  it('a clean finish shows for 6 s', () => {
    expect(cardShown(done(), { finishedSeenAt: now - 5_000, dismissed: false, now })).toBe(true);
    expect(cardShown(done(), { finishedSeenAt: now - 7_000, dismissed: false, now })).toBe(false);
    expect(cardShown(done(), { finishedSeenAt: null, dismissed: false, now })).toBe(true);
  });
  it('a failure, a cancel or a kept drawer stays until closed', () => {
    for (const j of [done({ failed: [{ name: 'a', reason: 'r' }] }), done({ cancel: { move: false, source: null } }), done({ cancelled: 1 }),
      done({ writes: [w({ status: 'done', kept: true })] }), done({ writes: [w({ status: 'failed', reason: 'In use on the Amiga' })] })]) {
      expect(isClean(j)).toBe(false);
      expect(cardShown(j, { finishedSeenAt: now - 60_000, dismissed: false, now })).toBe(true);
      expect(cardShown(j, { finishedSeenAt: now - 60_000, dismissed: true, now })).toBe(false);
    }
  });
  it('a running card shows whatever was remembered', () => {
    expect(cardShown(job(), { finishedSeenAt: null, dismissed: true, now })).toBe(true);
  });
});

describe('pillWords (spec §3: bytes over all running jobs)', () => {
  it('one job, two jobs, none running', () => {
    expect(pillWords([job()])).toBe('1 job · 24 %');
    // Review Focus 2: two at once, summed by bytes.
    expect(pillWords([job({ bytes: { total: 1000, done: 200 } }), job({ id: 'j2', bytes: { total: 3000, done: 1000 } })])).toBe('2 jobs · 30 %');
    expect(pillWords([done(), done({ id: 'j2' })])).toBe('2 finished');
    expect(pillWords([done()])).toBe('1 finished');
  });
});

describe('canCancel and confirmWords (spec §5, §6)', () => {
  it('only a running job not cancelled yet', () => {
    expect(canCancel(job())).toBe(true);
    expect(canCancel(job({ cancel: { move: false, source: null } }))).toBe(false);
    expect(canCancel(done())).toBe(false);
  });
  it('asks first, in the job\'s own noun', () => {
    expect(confirmWords(job())).toBe('Cancel the rest of this copy? What has arrived stays.');
    expect(confirmWords(job({ kind: 'move' }))).toBe('Cancel the rest of this move? What has arrived stays.');
    expect(confirmWords(job({ kind: 'send' }))).toBe('Cancel the rest of this send? What has arrived stays.');
    expect(confirmWords(job({ kind: 'write' }))).toBe('Cancel the rest of these changes? What is done stays.');
  });
});

describe('commonDrawer', () => {
  it('the drawer the paths share', () => {
    expect(commonDrawer(['Workbench:Monkey/Disk1/a', 'Workbench:Monkey/Disk2/b'])).toBe('Workbench:Monkey');
    expect(commonDrawer(['Work:Tools/x'])).toBe('Work:Tools');
    expect(commonDrawer(['STASH:/Pack/a', 'STASH:/Pack/b'])).toBe('STASH:/Pack');
    expect(commonDrawer(['STASH:/a.txt', 'STASH:/Pack/b'])).toBe('STASH:');
    expect(commonDrawer(['work:tools/a', 'Work:Tools/b'])).toBe('work:tools');
    expect(commonDrawer([])).toBeNull();
    expect(commonDrawer(['Work:a', 'DH1:b'])).toBeNull();
  });
});

describe('panelLift', () => {
  it('above the lowest anchor on screen, else nothing', () => {
    expect(panelLift([], 800)).toBe(0);
    expect(panelLift([700], 800)).toBe(108);
    expect(panelLift([0, 650], 800)).toBe(158);
    expect(panelLift([900], 800)).toBe(0);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run src/lib/files/job-view.test.ts`
Expected: FAIL — cannot resolve `./job-view`.

- [ ] **Step 7: Write `job-view.ts`**

Create `src/lib/files/job-view.ts`:

```ts
// src/lib/files/job-view.ts
// The progress panel's words (spec 2026-11-01-progress-panel §3, §5, §6): one job as GET /api/files/jobs sends it, and
// the pure rules that turn it into a card -- title, bar, line, estimate, result, the pill -- plus the constants the
// server and the client share. CLIENT-SAFE: no database import.
import { jobStatus, runningWriteLine, RUNNING_WORDS, type JobProgressView } from './manager-rules';

/** A job finished this long ago is still listed, so a reload shows its result (spec §4). */
export const JOB_SHOWN_MS = 120_000;
/** The id prefix of a board's plain Queue sends, one synthetic job per board (spec §4): `queue:<deviceId>:<ms>`. */
export const QUEUE_JOB = 'queue:';
/** The remote_requests kind that records a Cancel the rest (never sent to a board). */
export const CANCEL_KIND = 'cancel';
/** The words (and error code) of a part withdrawn by Cancel the rest -- and of a queue row a Queue Delete cancelled. */
export const CANCELLED = 'cancelled';
/** A clean finish fades after this (spec §3). */
export const FADE_MS = 6_000;
/** The estimate shows only after this much progress (spec §3)... */
export const WARMUP_MS = 10_000;
/** ...and is the rate over this last stretch of bytes. */
export const WINDOW_MS = 30_000;
/** A kept card lists this many failed files, then "and N more" (spec §3). */
export const FAILED_SHOWN = 5;

export type JobKind = 'copy' | 'move' | 'send' | 'write';
/** One job (spec §4). `board`: the board the job is about (the destination between two boards); `from`: then the source's. */
export type JobView = JobProgressView & {
  id: string; kind: JobKind; board: string; from: string | null;
  /** The drawer the files go into ('to'), the STASH:/LIBRARY: place ('from'); null for writes and plain sends. */
  place: string | null;
  /** A write job's one kind (delete, rename, …), null when it mixes kinds or is not a write job. */
  writeKind: string | null;
  offline: string | null; arrived: string[];
  /** Parts withdrawn (Cancel the rest, or a Queue Delete): counted apart from `failed`. */
  cancelled: number;
  /** Set once Cancel the rest ran: whether the job was a move, and where what did not go still is. */
  cancel: { move: boolean; source: string | null } | null;
  bytes: { total: number; done: number } | null;
  /** The file moving now (an Amiga path), while it runs. */
  current: string | null;
  running: boolean; startedAt: string; finishedAt: string | null;
};
export type Sample = { at: number; done: number };

const KB = 1024;
const MB = 1024 * 1024;
const pct = (a: number, b: number) => Math.min(100, Math.max(0, Math.floor((a * 100) / b)));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const loudOf = (j: JobView) => j.writes.filter((w) => !w.quiet);
const notCancelled = (j: JobView) => j.writes.filter((w) => w.reason !== CANCELLED);

/**
 * The drawer every path is in (Amiga `Work:a/b` or Files `STASH:/a/b`, compared case-insensitively): a path's own name
 * is never part of it. Null for no paths or paths on different devices.
 */
export function commonDrawer(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let slash = false;
  const drawers: { dev: string; segs: string[] }[] = [];
  for (const p of paths) {
    const c = p.indexOf(':');
    if (c < 0) return null;
    if (p[c + 1] === '/') slash = true;
    drawers.push({ dev: p.slice(0, c + 1), segs: p.slice(c + 1).split('/').filter(Boolean).slice(0, -1) });
  }
  const [first, ...rest] = drawers;
  let common = first.segs;
  for (const d of rest) {
    if (d.dev.toLowerCase() !== first.dev.toLowerCase()) return null;
    let k = 0;
    while (k < common.length && k < d.segs.length && common[k].toLowerCase() === d.segs[k].toLowerCase()) k++;
    common = common.slice(0, k);
  }
  return first.dev + (slash && common.length ? '/' : '') + common.join('/');
}

/** What and where (spec §3). */
export function jobTitle(j: JobView): string {
  if (j.kind === 'send') return `Sending ${plural(j.total, 'file', 'files')} to ${j.board}`;
  if (j.kind === 'write') {
    const loud = loudOf(j);
    if (loud.length === 0) return `Changing the disks of ${j.board}`;
    if (loud.length === 1) return `${RUNNING_WORDS[loud[0].kind] ?? 'Changing'} ${loud[0].label} on ${j.board}`;
    return `${j.writeKind ? RUNNING_WORDS[j.writeKind] ?? 'Changing' : 'Changing'} ${loud.length} items on ${j.board}`;
  }
  const verb = j.kind === 'move' ? 'Moving' : 'Copying';
  if (j.direction === 'from') return `${verb} from ${j.board}${j.place ? ` to ${j.place}` : ''}`;
  const at = j.place ? ` · ${j.place}` : '';
  return j.from ? `${verb} from ${j.from} to ${j.board}${at}` : `${verb} to ${j.board}${at}`;
}

/** "2.4 of 9.8 MB"; under a megabyte "12 of 820 KB". */
export function sizeWords(done: number, total: number): string {
  if (total < MB) return `${Math.round(done / KB)} of ${Math.max(1, Math.round(total / KB))} KB`;
  return `${(done / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`;
}

export function leftWords(sec: number): string {
  if (sec < 45) return 'less than a minute left';
  return `about ${Math.round(sec / 60)} min left`;
}

/** Files ended of all (a job with files), else its loud writes ended of all. */
export function itemsOf(j: JobView): { ended: number; total: number; noun: 'files' | 'items' } {
  if (j.total > 0) return { ended: Math.max(0, j.total - j.waiting), total: j.total, noun: 'files' };
  const loud = loudOf(j);
  return { ended: loud.filter((w) => w.status === 'done' || w.status === 'failed').length, total: loud.length, noun: 'items' };
}

/** The bar (0-100): by bytes where they are known and not all empty, by items otherwise (spec §3). */
export function barOf(j: JobView): { value: number; byBytes: boolean } {
  if (j.bytes && j.bytes.total > 0) return { value: pct(j.bytes.done, j.bytes.total), byBytes: true };
  const it = itemsOf(j);
  return { value: it.total ? pct(it.ended, it.total) : 0, byBytes: false };
}

/**
 * Seconds left, or null: only while it runs with known bytes and its board online, only once bytes have moved for
 * WARMUP_MS, and at the rate of the samples in the last WINDOW_MS.
 */
export function timeLeft(samples: Sample[], j: Pick<JobView, 'bytes' | 'offline' | 'running'>, now: number): number | null {
  if (!j.running || j.offline || !j.bytes || j.bytes.total <= 0 || samples.length === 0) return null;
  const moved = samples.find((s) => s.done > samples[0].done);
  if (!moved || now - moved.at < WARMUP_MS) return null;
  const recent = samples.filter((s) => s.at >= now - WINDOW_MS);
  if (recent.length < 2) return null;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const rate = (b.done - a.done) / ((b.at - a.at) / 1000);
  if (!(rate > 0)) return null;
  return Math.max(0, (j.bytes.total - j.bytes.done) / rate);
}

/** "3 of 12 files · 2.4 of 9.8 MB · about 1 min left"; an offline board waits instead of an estimate (spec §3). */
export function jobLine(j: JobView, left: number | null): string {
  const it = itemsOf(j);
  const parts = [it.noun === 'files' ? `${it.ended} of ${plural(it.total, 'file', 'files')}` : `${it.ended} of ${plural(it.total, 'item', 'items')}`];
  if (j.bytes && j.bytes.total > 0) parts.push(sizeWords(j.bytes.done, j.bytes.total));
  if (j.offline) parts.push(`Waiting for ${j.offline} (offline)`);
  else if (left !== null) parts.push(leftWords(left));
  return parts.join(' · ');
}

/** The card's second line while it runs: the file moving now, else the write running (with a delete's count). */
export function jobNow(j: JobView): string | null {
  if (!j.running) return null;
  return j.current ?? runningWriteLine(j, j.board);
}

/** A finished card's words: Cancel's, a send's, else today's finished line (jobStatus) and what was cancelled elsewhere. */
export function resultWords(j: JobView): string {
  if (j.cancel) {
    const verb = j.kind === 'move' ? 'moved' : j.kind === 'send' ? 'sent' : j.kind === 'write' ? 'done' : 'copied';
    const loud = loudOf(j);
    const [done, total] = j.total > 0 ? [j.done, j.total] : [loud.filter((w) => w.status === 'done').length, loud.length];
    const fails = j.failed.length ? `, ${j.failed.length} failed` : '';
    const rest = j.kind === 'move' && j.cancel.source ? `; the rest is still in ${j.cancel.source}` : '';
    return `Cancelled: ${done} of ${total} ${verb}${fails}${rest}`;
  }
  if (j.kind === 'send') {
    const [first, ...more] = j.failed;
    return `Sent ${plural(j.done, 'file', 'files')} to ${j.board}${j.cancelled ? `, ${j.cancelled} cancelled` : ''}`
      + (first ? `, ${j.failed.length} failed: ${first.name}: ${first.reason}${more.length ? '; …' : ''}` : '');
  }
  const line = jobStatus({ ...j, writes: notCancelled(j) }, j.board).line;
  return j.cancelled ? `${line} · ${j.cancelled} cancelled` : line;
}

/** The failed files of a kept card: the first five, then "and N more" (spec §3). */
export function failureList(j: JobView): string[] {
  const all = j.failed.map((f) => `${f.name}: ${f.reason}`);
  return all.length > FAILED_SHOWN ? [...all.slice(0, FAILED_SHOWN), `and ${all.length - FAILED_SHOWN} more`] : all;
}

/** Nothing failed, nothing cancelled, no drawer kept: a clean finish, which fades. */
export function isClean(j: JobView): boolean {
  return !j.cancel && j.cancelled === 0 && j.failed.length === 0
    && !j.writes.some((w) => (w.status === 'failed' && w.reason !== CANCELLED) || w.kept);
}

/** Whether a card shows: running always; finished clean for FADE_MS after it was first seen finished; else until closed. */
export function cardShown(j: JobView, s: { finishedSeenAt: number | null; dismissed: boolean; now: number }): boolean {
  if (j.running) return true;
  if (s.dismissed) return false;
  if (!isClean(j)) return true;
  return s.finishedSeenAt === null || s.now - s.finishedSeenAt < FADE_MS;
}

/** The collapsed pill: running jobs and their bytes together (by items when none has bytes), else what is finished. */
export function pillWords(jobs: JobView[]): string {
  const running = jobs.filter((j) => j.running);
  if (running.length === 0) return jobs.length === 1 ? '1 finished' : `${jobs.length} finished`;
  const withBytes = running.filter((j) => j.bytes && j.bytes.total > 0);
  const value = withBytes.length
    ? pct(withBytes.reduce((n, j) => n + j.bytes!.done, 0), withBytes.reduce((n, j) => n + j.bytes!.total, 0))
    : Math.floor(running.reduce((n, j) => n + barOf(j).value, 0) / running.length);
  return `${plural(running.length, 'job', 'jobs')} · ${value} %`;
}

export function canCancel(j: JobView): boolean {
  return j.running && !j.cancel;
}

/** Cancel asks first (spec §5). */
export function confirmWords(j: JobView): string {
  if (j.kind === 'write') return 'Cancel the rest of these changes? What is done stays.';
  return `Cancel the rest of this ${j.kind}? What has arrived stays.`;
}

/** How far above the viewport's bottom the panel sits to clear the lowest anchor on screen (the Files bar), else 0. */
export function panelLift(anchorTops: number[], viewport: number): number {
  const on = anchorTops.filter((t) => t > 0 && t < viewport);
  return on.length ? Math.ceil(viewport - Math.min(...on) + 8) : 0;
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run src/lib/files/job-view.test.ts src/lib/files/manager-rules.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/files/job-view.ts src/lib/files/job-view.test.ts src/lib/files/manager-rules.ts src/lib/files/manager-rules.test.ts`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git status
git add src/lib/files/job-view.ts src/lib/files/job-view.test.ts src/lib/files/manager-rules.ts src/lib/files/manager-rules.test.ts
git commit -m "Progress panel: the card's words, bar, estimate and pill as pure rules; runningWriteLine out of jobLine"
```

---

### Task 2: The server's job listing (`GET /api/files/jobs`)

**Files:**
- Modify: `src/lib/remote-requests.ts:23-37` (GetTarget gains `size`)
- Modify: `src/lib/files/net-fetch.ts:151-152` (startFetch), `src/lib/files/net-fetch.ts:206-213` (volumeToVolume)
- Modify: `src/lib/files/net-fetch.db.test.ts:108-111`, `:164` (targets now carry `size`)
- Create: `src/lib/files/jobs.ts`
- Create: `src/app/api/files/jobs/route.ts`
- Test: `src/lib/files/jobs.db.test.ts` (new)

**Interfaces:**
- Consumes: `fetchProgress(db, orgId, fetchId, now): Promise<FetchProgress | null>` (net-fetch.ts); `jobStatus` (manager-rules); `JobView`, `commonDrawer`, `JOB_SHOWN_MS`, `QUEUE_JOB`, `CANCEL_KIND`, `CANCELLED` (Task 1); `isOnline(lastSeenAt, nowMs)`; `failureText(code, text)`.
- Produces: `listJobs(db: Db, orgId: string, now?: Date): Promise<JobView[]>` (newest first); `GET /api/files/jobs` → `{ jobs: JobView[] }`, `cache-control: no-store`; a synthetic Queue job's id is `` `queue:${deviceId}:${newestRowCreatedAtMs}` ``.

- [ ] **Step 1: Write the failing DB tests**

Create `src/lib/files/jobs.db.test.ts`:

```ts
// src/lib/files/jobs.db.test.ts
// Progress panel (spec 2026-11-01-progress-panel §4): GET /api/files/jobs's listing -- the org's Files jobs from both
// tables in both directions with their bytes, the 2-minute window, one job per board for plain Queue sends, and
// never another org's.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_jobs_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-jobs-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { amigaUploads } = await import('@/db/schema/amiga-uploads');
const { listJobs } = await import('./jobs');

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = new Date(NOW.getTime() + 24 * 3600_000);
type Tr = typeof transfers.$inferInsert;
const tr = (id: string, o: Partial<Tr>): Tr => ({ id, orgId: 'o1', deviceId: 'b1', createdByUserId: 'u1', path: id, sizeBytes: 1000, crc32: 0,
  blobSha256: 'a'.repeat(64), expiresAt: later, status: 'queued', createdAt: ago(10_000), ...o });
type Rq = typeof remoteRequests.$inferInsert;
const rq = (id: string, o: Partial<Rq>): Rq => ({ id, orgId: 'o1', deviceId: 'b1', kind: 'get', amigaPath: `Work:${id}`, status: 'waiting', createdAt: ago(10_000), ...o });
const target = (o: Record<string, unknown> = {}) => ({ dest: 'STASH:/In', rel: ['x'], replace: false, library: null, ...o });
const up = (id: string, size: number, received: number, status = 'receiving', source = 'copy') => ({ id, orgId: 'o1', deviceId: 'b1', path: id,
  sizeBytes: size, receivedBytes: received, amigaDate: '1.2.3', status, source, expiresAt: later });
const jobs = () => listJobs(getDb(), 'o1', NOW);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: NOW }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: NOW }]);
  await getDb().insert(devices).values([
    { id: 'b1', orgId: 'o1', name: 'A500', tokenHash: 'h1', lastSeenAt: NOW },
    { id: 'b2', orgId: 'o1', name: 'A1200', tokenHash: 'h2', lastSeenAt: NOW },
    { id: 'b3', orgId: 'o2', name: 'Other', tokenHash: 'h3', lastSeenAt: NOW },
  ]);
});
beforeEach(async () => {
  await getDb().delete(transfers);
  await getDb().delete(remoteRequests);
  await getDb().delete(amigaUploads);
  await getDb().update(devices).set({ lastSeenAt: NOW });
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('listJobs: Files jobs', () => {
  it('a copy onto a volume: its bytes, the drawer it goes into, the file moving now', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:Tools/Pack/a' }),
      tr('r2', { jobId: 'j1', status: 'sending', sizeBytes: 3000, bytesSent: 1000, amigaDest: 'Work:Tools/Pack/b', createdAt: ago(9_999) }),
      tr('r3', { jobId: 'j1', sizeBytes: 2000, amigaDest: 'Work:Tools/Pack/c', createdAt: ago(9_998) }),
    ]);
    expect(await jobs()).toEqual([expect.objectContaining({ id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools/Pack',
      total: 3, done: 1, waiting: 2, failed: [], cancelled: 0, cancel: null, bytes: { total: 6000, done: 2000 }, current: 'Work:Tools/Pack/b',
      running: true, startedAt: ago(10_000).toISOString(), finishedAt: null, offline: null })]);
  });

  it('a move onto a volume is a move', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a', moveSource: 'STASH:/a', moveItem: 'a' })]);
    expect((await jobs())[0]).toMatchObject({ kind: 'move' });
  });

  it('a copy off a volume: bytes from each get\'s size and the arriving upload', async () => {
    await getDb().insert(amigaUploads).values([up('u1', 500, 500, 'stored'), up('u2', 800, 200)]);
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j2', status: 'done', uploadId: 'u1', answeredAt: ago(3_000), target: target({ rel: ['a'], size: 500 }) }),
      rq('g2', { fetchId: 'j2', status: 'fetching', uploadId: 'u2', amigaPath: 'Work:b', target: target({ rel: ['b'], size: 800 }) }),
      rq('g3', { fetchId: 'j2', target: target({ rel: ['c'], size: 100 }) }),
    ]);
    expect((await jobs())[0]).toMatchObject({ id: 'j2', kind: 'copy', direction: 'from', board: 'A500', place: 'STASH:/In', total: 3, done: 1,
      waiting: 2, bytes: { total: 1400, done: 700 }, current: 'Work:b', running: true });
  });

  it('a copy onto LIBRARY: says LIBRARY:', async () => {
    await getDb().insert(remoteRequests).values([rq('g1', { fetchId: 'j2', target: target({ dest: 'STASH:', library: { collectionId: null }, size: 9 }) })]);
    expect((await jobs())[0]).toMatchObject({ direction: 'from', place: 'LIBRARY:' });
  });

  it('between volumes: the destination board, the source board, each file once (half up, half down)', async () => {
    await getDb().insert(amigaUploads).values([up('u3', 1000, 600, 'receiving', 'staging')]);
    const relay = (dest: string) => ({ deviceId: 'b2', dest, onClash: 'keep' });
    await getDb().insert(remoteRequests).values([
      rq('gA', { fetchId: 'j3', status: 'done', amigaPath: 'Work:Pack/x', answeredAt: ago(4_000), target: target({ dest: 'STASH:', size: 1000, relay: relay('Data:Pack/x') }) }),
      rq('gB', { fetchId: 'j3', status: 'fetching', amigaPath: 'Work:Pack/y', uploadId: 'u3', target: target({ dest: 'STASH:', size: 1000, relay: relay('Data:Pack/y') }) }),
    ]);
    await getDb().insert(transfers).values([tr('rA', { jobId: 'j3', deviceId: 'b2', status: 'sending', bytesSent: 400, amigaDest: 'Data:Pack/x' })]);
    expect((await jobs())[0]).toMatchObject({ id: 'j3', kind: 'copy', direction: 'to', board: 'A1200', from: 'A500', place: 'Data:Pack',
      bytes: { total: 2000, done: 1000 }, current: 'Data:Pack/x', running: true });
  });

  it('a drawer delete is a write job: by items, its kind named', async () => {
    await getDb().insert(remoteRequests).values([
      rq('w1', { fetchId: 'j4', kind: 'delete', amigaPath: 'Work:Old', target: { label: 'Work:Old' } }),
      rq('w2', { fetchId: 'j4', kind: 'delete', amigaPath: 'Work:Old.info', target: { label: 'Work:Old.info', icon: true }, createdAt: ago(9_999) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ id: 'j4', kind: 'write', writeKind: 'delete', place: null, bytes: null, total: 0, running: true });
    expect(j.writes.map((w) => [w.label, w.status, w.quiet])).toEqual([['Work:Old', 'waiting', false], ['Work:Old.info', 'waiting', true]]);
  });

  it('finished within 2 minutes stays, with its finish time; older is gone', async () => {
    await getDb().insert(transfers).values([
      tr('r5', { jobId: 'j5', status: 'delivered', finishedAt: ago(90_000), amigaDest: 'Work:a', createdAt: ago(100_000) }),
      tr('r6', { jobId: 'j6', status: 'delivered', finishedAt: ago(150_000), amigaDest: 'Work:b', createdAt: ago(160_000) }),
    ]);
    const list = await jobs();
    expect(list.map((j) => j.id)).toEqual(['j5']);
    expect(list[0]).toMatchObject({ running: false, done: 1, finishedAt: ago(90_000).toISOString(), current: null });
  });

  it('a part cancelled is counted apart from the failures', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:a' }),
      tr('r2', { jobId: 'j1', status: 'cancelled', finishedAt: ago(4_000), amigaDest: 'Work:b' }),
      tr('r3', { jobId: 'j1', status: 'failed', errorCode: 'space', finishedAt: ago(4_000), amigaDest: 'Work:c' }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ cancelled: 1, running: false });
    expect(j.failed.map((f) => f.name)).toEqual(['r3']);
  });

  it('a board it waits on that is offline is named', async () => {
    await getDb().update(devices).set({ lastSeenAt: ago(5 * 60_000) }).where(eq(devices.id, 'b2'));
    await getDb().insert(transfers).values([tr('r8', { jobId: 'j8', deviceId: 'b2', amigaDest: 'Data:a' })]);
    expect((await jobs())[0]).toMatchObject({ id: 'j8', offline: 'A1200', running: true });
  });

  it('newest first', async () => {
    await getDb().insert(transfers).values([
      tr('r9', { jobId: 'j9', amigaDest: 'Work:a', createdAt: ago(5_000) }),
      tr('r10', { jobId: 'j10', amigaDest: 'Work:b', createdAt: ago(8_000) }),
    ]);
    expect((await jobs()).map((j) => j.id)).toEqual(['j9', 'j10']);
  });

  it('another org\'s jobs never show', async () => {
    await getDb().insert(transfers).values([tr('r7', { jobId: 'j7', orgId: 'o2', deviceId: 'b3', amigaDest: 'Work:a' }), tr('q1', { orgId: 'o2', deviceId: 'b3' })]);
    expect(await jobs()).toEqual([]);
    expect((await listJobs(getDb(), 'o2', NOW)).map((j) => j.kind).sort()).toEqual(['copy', 'send']);
  });
});

describe('listJobs: plain Queue sends', () => {
  it('one job per board: what waits or moves and what finished since it began', async () => {
    await getDb().insert(transfers).values([
      tr('q-old', { status: 'delivered', createdAt: ago(900_000), finishedAt: ago(600_000) }),
      tr('q-a', { status: 'delivered', createdAt: ago(20_000), finishedAt: ago(5_000) }),
      tr('q-b', { status: 'sending', bytesSent: 400, createdAt: ago(19_999) }),
      tr('q-c', { createdAt: ago(19_998) }),
    ]);
    expect(await jobs()).toEqual([expect.objectContaining({ id: `queue:b1:${ago(19_998).getTime()}`, kind: 'send', direction: 'to', board: 'A500',
      place: null, total: 3, done: 1, waiting: 2, bytes: { total: 3000, done: 1400 }, current: 'q-b', running: true,
      startedAt: ago(20_000).toISOString() })]);
  });

  it('once through it stays 2 minutes with its failures', async () => {
    await getDb().insert(transfers).values([
      tr('q-a', { status: 'delivered', createdAt: ago(20_000), finishedAt: ago(10_000) }),
      tr('q-b', { status: 'failed', errorCode: 'norx', createdAt: ago(19_999), finishedAt: ago(5_000) }),
    ]);
    const [j] = await jobs();
    expect(j).toMatchObject({ kind: 'send', running: false, total: 2, done: 1, finishedAt: ago(5_000).toISOString() });
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0].name).toBe('q-b');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=$(WEBADF_PG_NAME=webadf-pg-e2e WEBADF_PG_PORT=55433 bash scripts/dev-db.sh start) pnpm test:db src/lib/files/jobs.db.test.ts`
Expected: FAIL — cannot resolve `./jobs`.

- [ ] **Step 3: Carry each get's size from the start of the copy**

In `src/lib/remote-requests.ts`, inside `export type GetTarget = {…}`, add after `userId?: string`:

```ts
  /** The file's size as the copy's walk saw it: the progress panel's bytes before its upload opens (spec 2026-11-01 §4). */
  size?: number };
```

(and remove the `};` that closed the type after `userId?: string`, so the type still ends once).

In `src/lib/files/net-fetch.ts` `startFetch`, change

```ts
    target: { dest: formatPath(dest), rel: f.rel, replace: replace.has(top), library, ...move(top, f) } satisfies GetTarget })));
```

to

```ts
    target: { dest: formatPath(dest), rel: f.rel, replace: replace.has(top), library, size: f.size, ...move(top, f) } satisfies GetTarget })));
```

In `volumeToVolume`, change

```ts
    return { amigaPath: f.amigaPath, target: { dest: 'STASH:', rel: [rel[rel.length - 1]], replace: false, library: null,
```

to

```ts
    return { amigaPath: f.amigaPath, target: { dest: 'STASH:', rel: [rel[rel.length - 1]], replace: false, library: null, size: f.size,
```

In `src/lib/files/net-fetch.db.test.ts` update the two exact expectations:

```ts
      ['Work:Sub/b.txt', r.fetching!.id, 'waiting', { dest: 'STASH:/In', rel: ['Sub', 'b.txt'], replace: false, library: null, size: 10 }],
      ['Work:a.lha', r.fetching!.id, 'waiting', { dest: 'STASH:/In', rel: ['a.lha'], replace: false, library: null, size: 1000 }],
```

and

```ts
    expect(rows.map((g) => g.target)).toEqual([{ dest: 'STASH:', rel: ['Games.adf'], replace: false, library: { collectionId: null }, size: 901120 }]);
```

- [ ] **Step 4: Write `jobs.ts`**

Create `src/lib/files/jobs.ts`:

```ts
// src/lib/files/jobs.ts
// The progress panel's record (spec 2026-11-01-progress-panel §4): the org's jobs that run, or finished in the last
// 2 minutes -- every Files job (transfers.job_id, remote_requests.fetch_id) with fetchProgress's fields, its bytes and
// what its card's title names; and per board one job for the plain Queue sends, which have no job id. Plain Postgres
// queries over transfers, remote_requests and amiga_uploads: nothing hosted-only, no table of its own. SERVER ONLY.
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { isOnline } from '@/lib/device-state';
import { failureText } from '@/lib/send-ui';
import type { GetTarget, RemoteRow } from '@/lib/remote-requests';
import { jobStatus } from './manager-rules';
import { fetchProgress } from './net-fetch';
import { CANCEL_KIND, CANCELLED, commonDrawer, JOB_SHOWN_MS, QUEUE_JOB, type JobKind, type JobView } from './job-view';

type TransferRow = typeof transfers.$inferSelect;
const ACTIVE = ['queued', 'sending'];
/** A request of a job not yet ended (a move's removal decided and not recorded is `settling`). */
const LIVE = ['waiting', 'sent', 'fetching', 'placing', 'settling'];
const iso = (d: Date) => d.toISOString();
const latest = (ds: Date[]) => (ds.length ? iso(new Date(Math.max(...ds.map((d) => d.getTime())))) : null);

/** The org's jobs, newest first. */
export async function listJobs(db: Db, orgId: string, now = new Date()): Promise<JobView[]> {
  const since = new Date(now.getTime() - JOB_SHOWN_MS);
  const a = await db.selectDistinct({ id: transfers.jobId }).from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNotNull(transfers.jobId), or(inArray(transfers.status, ACTIVE), gte(transfers.finishedAt, since))));
  const b = await db.selectDistinct({ id: remoteRequests.fetchId }).from(remoteRequests)
    .where(and(eq(remoteRequests.orgId, orgId), isNotNull(remoteRequests.fetchId),
      or(inArray(remoteRequests.status, LIVE), gte(remoteRequests.answeredAt, since))));
  const ids = [...new Set([...a, ...b].map((r) => r.id!))];
  const out: JobView[] = [];
  for (const id of ids) {
    const j = await jobOf(db, orgId, id, now);
    if (j && (j.running || (j.finishedAt !== null && j.finishedAt >= iso(since)))) out.push(j);
  }
  out.push(...(await queueJobs(db, orgId, now)));
  return out.sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.id.localeCompare(y.id));
}

async function boardNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: devices.id, name: devices.name }).from(devices).where(inArray(devices.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}

async function uploadsOf(db: Db, orgId: string, gets: RemoteRow[]): Promise<Map<string, { size: number; received: number }>> {
  const ids = gets.map((g) => g.uploadId).filter((x): x is string => !!x);
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: amigaUploads.id, size: amigaUploads.sizeBytes, received: amigaUploads.receivedBytes }).from(amigaUploads)
    .where(and(inArray(amigaUploads.id, ids), eq(amigaUploads.orgId, orgId)));
  return new Map(rows.map((r) => [r.id, { size: r.size, received: r.received }] as const));
}

/**
 * A job's bytes: a get's file by its size (from the copy's walk, else its upload's) and what of it arrived; a queue row by
 * its size and the board's last fetched chunk; any ended part whole, so the bar ends with the job. Between volumes each
 * file counts once -- its way up the first half, its queue row (once handed over) the second.
 */
function bytesOf(gets: RemoteRow[], uploads: Map<string, { size: number; received: number }>, sent: TransferRow[], relayed: boolean) {
  let total = 0;
  let done = 0;
  for (const g of gets) {
    const t = g.target as GetTarget;
    const u = g.uploadId ? uploads.get(g.uploadId) : undefined;
    const size = t.size ?? u?.size ?? 0;
    const up = g.status === 'done' || g.status === 'failed' || g.status === 'placing' ? size : u?.received ?? 0;
    total += size;
    if (!t.relay) done += up;
    else if (g.status === 'failed') done += size;
    else if (g.status !== 'done') done += Math.floor(up / 2);   // a relayed get once done is its queue row's
  }
  for (const x of sent) {
    const part = ACTIVE.includes(x.status) ? x.bytesSent : x.sizeBytes;
    if (relayed) done += Math.floor(x.sizeBytes / 2) + Math.floor(part / 2);
    else { total += x.sizeBytes; done += part; }
  }
  return { total, done: Math.min(done, total) };
}

async function jobOf(db: Db, orgId: string, id: string, now: Date): Promise<JobView | null> {
  const p = await fetchProgress(db, orgId, id, now);
  if (!p) return null;
  const reqs = await db.select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, id), eq(remoteRequests.orgId, orgId)))
    .orderBy(asc(remoteRequests.createdAt), asc(remoteRequests.id));
  const sent = await db.select().from(transfers).where(and(eq(transfers.jobId, id), eq(transfers.orgId, orgId)))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  const gets = reqs.filter((r) => r.kind === 'get');
  const relay = gets.map((g) => (g.target as GetTarget).relay).find((x) => !!x) ?? null;
  const marker = reqs.find((r) => r.kind === CANCEL_KIND) ?? null;
  const names = await boardNames(db, [...(relay ? [relay.deviceId] : []), ...gets.slice(0, 1).map((g) => g.deviceId)]);
  // A part withdrawn by Cancel the rest (or a Queue Delete) says `cancelled`: counted apart, never a failure.
  const failed = p.failed.filter((f) => f.reason !== CANCELLED);
  const cancelled = p.failed.length - failed.length + p.writes.filter((w) => w.reason === CANCELLED).length;
  const running = !jobStatus({ ...p, failed, writes: p.writes.filter((w) => w.reason !== CANCELLED) }, p.board).finished;
  const markerTarget = (marker?.target ?? {}) as { move?: boolean; source?: string | null };
  const moved = sent.some((x) => x.moveSource !== null || x.moveItem !== null)
    || gets.some((g) => (g.target as GetTarget).moveSeen !== undefined) || !!markerTarget.move;
  const kind: JobKind = sent.length || gets.length ? (moved ? 'move' : 'copy') : 'write';
  const loudKinds = [...new Set(p.writes.filter((w) => !w.quiet).map((w) => w.kind))];
  const dests = [...sent.map((x) => x.amigaDest), ...gets.map((g) => (g.target as GetTarget).relay?.dest ?? null)].filter((x): x is string => !!x);
  const first = gets[0]?.target as GetTarget | undefined;
  const place = kind === 'write' ? null : p.direction === 'to' ? commonDrawer(dests) : first ? (first.library ? 'LIBRARY:' : first.dest) : null;
  const moving = sent.find((x) => x.status === 'sending');
  const fetching = gets.find((g) => g.status === 'fetching') ?? gets.find((g) => g.status === 'sent');
  const starts = [...reqs.map((r) => r.createdAt), ...sent.map((x) => x.createdAt)];
  const ends = [...reqs.map((r) => r.answeredAt), ...sent.map((x) => x.finishedAt)].filter((x): x is Date => !!x);
  return {
    id, kind, direction: p.direction,
    board: relay ? names.get(relay.deviceId) ?? p.board : p.board,
    from: relay && gets[0] ? names.get(gets[0].deviceId) ?? null : null,
    place, writeKind: kind === 'write' && loudKinds.length === 1 ? loudKinds[0] : null,
    total: p.total, done: p.done, failed, waiting: p.waiting, skipped: p.skipped, writes: p.writes, offline: p.offline, arrived: p.arrived,
    cancelled, cancel: marker ? { move: !!markerTarget.move, source: markerTarget.source ?? null } : null,
    bytes: p.total > 0 ? bytesOf(gets, await uploadsOf(db, orgId, gets), sent, !!relay) : null,
    current: !running ? null : moving ? moving.amigaDest ?? moving.path : fetching?.amigaPath ?? null,
    running,
    startedAt: iso(new Date(Math.min(...starts.map((d) => d.getTime())))),
    finishedAt: running ? null : latest(ends),
  };
}

/**
 * The plain Queue sends (spec §4): per board, its job-less rows that wait or move, with those that finished since the
 * oldest of them was queued -- or, once none waits, those that finished in the last 2 minutes. Its id carries the newest
 * row's time, so a later batch is a new card.
 */
async function queueJobs(db: Db, orgId: string, now: Date): Promise<JobView[]> {
  const since = now.getTime() - JOB_SHOWN_MS;
  const active = await db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNull(transfers.jobId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)));
  const start = new Map<string, number>();
  for (const r of active) start.set(r.deviceId, Math.min(start.get(r.deviceId) ?? Infinity, r.createdAt.getTime()));
  const ended = await db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNull(transfers.jobId), gte(transfers.finishedAt, new Date(Math.min(since, ...start.values())))));
  const byBoard = new Map<string, TransferRow[]>();
  for (const r of [...active, ...ended.filter((x) => x.finishedAt!.getTime() >= (start.get(x.deviceId) ?? since))]) {
    byBoard.set(r.deviceId, [...(byBoard.get(r.deviceId) ?? []), r]);
  }
  if (byBoard.size === 0) return [];
  const boards = await db.select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt }).from(devices)
    .where(inArray(devices.id, [...byBoard.keys()]));
  return boards.map((d): JobView => {
    const rows = byBoard.get(d.id)!.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));
    const waiting = rows.filter((x) => ACTIVE.includes(x.status));
    const running = waiting.length > 0;
    return {
      id: `${QUEUE_JOB}${d.id}:${rows[rows.length - 1].createdAt.getTime()}`, kind: 'send', direction: 'to', board: d.name, from: null,
      place: null, writeKind: null, total: rows.length, done: rows.filter((x) => x.status === 'delivered').length,
      failed: rows.filter((x) => x.status === 'failed' || x.status === 'expired').map((x) => ({ name: x.path,
        reason: x.status === 'expired' ? `${d.name} did not take it within 24 h` : failureText(x.errorCode, x.errorText) })),
      waiting: waiting.length, skipped: rows.filter((x) => x.status === 'skipped').length, writes: [],
      offline: running && !isOnline(d.lastSeenAt, now.getTime()) ? d.name : null, arrived: [],
      cancelled: rows.filter((x) => x.status === 'cancelled').length, cancel: null,
      bytes: { total: rows.reduce((n, x) => n + x.sizeBytes, 0), done: rows.reduce((n, x) => n + (ACTIVE.includes(x.status) ? x.bytesSent : x.sizeBytes), 0) },
      current: rows.find((x) => x.status === 'sending')?.path ?? null, running,
      startedAt: iso(rows[0].createdAt),
      finishedAt: running ? null : latest(rows.map((x) => x.finishedAt).filter((x): x is Date => !!x)),
    };
  });
}
```

- [ ] **Step 5: Write the route**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` first. Create `src/app/api/files/jobs/route.ts`:

```ts
// GET /api/files/jobs -- the progress panel's jobs (spec 2026-11-01-progress-panel §4): this org's Files jobs that run,
// or finished in the last 2 minutes, with their bytes; one job per board for plain Queue sends. Every page's panel asks.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listJobs } from '@/lib/files/jobs';

export async function GET() {
  const { orgId } = await requireOrg();
  const jobs = await listJobs(getDb(), orgId, new Date());
  return Response.json({ jobs }, { headers: { 'cache-control': 'no-store' } });
}
```

- [ ] **Step 6: Run the DB tests (new and the NET: ones the size touches)**

Run: `TEST_DATABASE_URL=$(WEBADF_PG_NAME=webadf-pg-e2e WEBADF_PG_PORT=55433 bash scripts/dev-db.sh start) pnpm test:db src/lib/files/jobs.db.test.ts src/lib/files/net-fetch.db.test.ts src/lib/files/vol-staging.db.test.ts src/lib/files/net-write.db.test.ts src/lib/files/net-consistency.db.test.ts`
Expected: PASS. If another exact `target` expectation fails only for the new `size` key, add the size it reports to that expectation and nothing else.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/files/jobs.ts src/lib/files/jobs.db.test.ts src/app/api/files/jobs/route.ts src/lib/remote-requests.ts src/lib/files/net-fetch.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git status
git add src/lib/files/jobs.ts src/lib/files/jobs.db.test.ts src/app/api/files/jobs/route.ts src/lib/remote-requests.ts src/lib/files/net-fetch.ts src/lib/files/net-fetch.db.test.ts
git commit -m "Progress panel: GET /api/files/jobs lists the org's running jobs with bytes, and one job per board for Queue sends"
```

---

### Task 3: Cancel the rest (`POST /api/files/jobs/<id>/cancel`)

**Files:**
- Modify: `src/lib/transfers.ts` (add `cancelQueueSends` after `cancelTransfer`, ~line 276)
- Create: `src/lib/files/job-cancel.ts`
- Create: `src/app/api/files/jobs/[id]/cancel/route.ts`
- Test: `src/lib/files/job-cancel.db.test.ts` (new)

**Interfaces:**
- Consumes: `CANCEL_KIND`, `CANCELLED`, `QUEUE_JOB`, `commonDrawer` (Task 1); `listJobs` (Task 2, in tests); `isWriteKind`, `GetTarget` (remote-requests); `newRequestId` (remote-wire).
- Produces: `cancelQueueSends(db: Db, orgId: string, deviceId: string, now?: Date): Promise<number>`; `cancelJob(db: Db, orgId: string, id: string, now?: Date): Promise<{ ok: true; cancelled: number } | { ok: false }>`; `POST /api/files/jobs/<id>/cancel` → `200 { ok: true, cancelled }` or `404 { error: 'not_found' }`.

- [ ] **Step 1: Write the failing DB tests**

Create `src/lib/files/job-cancel.db.test.ts`:

```ts
// src/lib/files/job-cancel.db.test.ts
// Progress panel, Cancel the rest (spec 2026-11-01-progress-panel §6): per kind -- queue rows to the Amiga cancelled,
// gets withdrawn and an arriving file stopped, waiting writes withdrawn (a running drawer delete finishes), a move
// keeping every source not yet removed -- and never another org's job.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from 'pg';

const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_files_job_cancel_test';
const url = new URL(base); url.pathname = `/${DB}`; process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR ??= (await import('node:fs')).mkdtempSync('/tmp/webadf-files-job-cancel-');
process.env.BLOB_READ_WRITE_TOKEN = '';
async function admin(stmt: string) { const c = new Client({ connectionString: base }); await c.connect(); try { await c.query(stmt); } finally { await c.end(); } }
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('@/lib/tosec-sweep', () => ({ sweep: async () => {} }));

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const { and, eq, ne } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { transfers } = await import('@/db/schema/transfers');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { amigaUploads, amigaUploadChunks } = await import('@/db/schema/amiga-uploads');
const { recordChunk } = await import('@/lib/transfers');
const { storeChunk, openUpload } = await import('@/lib/amiga-uploads');
const { settleMovesOfJob } = await import('./net-moves');
const { listJobs } = await import('./jobs');
const { cancelJob } = await import('./job-cancel');

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = new Date(NOW.getTime() + 24 * 3600_000);
type Tr = typeof transfers.$inferInsert;
const tr = (id: string, o: Partial<Tr>): Tr => ({ id, orgId: 'o1', deviceId: 'b1', createdByUserId: 'u1', path: id, sizeBytes: 1000, crc32: 0,
  blobSha256: 'a'.repeat(64), expiresAt: later, status: 'queued', createdAt: ago(10_000), ...o });
type Rq = typeof remoteRequests.$inferInsert;
const rq = (id: string, o: Partial<Rq>): Rq => ({ id, orgId: 'o1', deviceId: 'b1', kind: 'get', amigaPath: `Work:${id}`, status: 'waiting', createdAt: ago(10_000), ...o });
const target = (o: Record<string, unknown> = {}) => ({ dest: 'STASH:/In', rel: ['x'], replace: false, library: null, size: 10, ...o });
const rowStatus = async (job: string) => Object.fromEntries((await getDb().select().from(transfers).where(eq(transfers.jobId, job))).map((r) => [r.id, r.status]));
const reqOf = async (id: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, id)))[0];
const sendVersion = async (id: string) => (await getDb().select({ v: devices.sendVersion }).from(devices).where(eq(devices.id, id)))[0].v;
const markers = async (job: string) => getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, job), eq(remoteRequests.kind, 'cancel')));
const jobOf = async (id: string) => (await listJobs(getDb(), 'o1', NOW)).find((j) => j.id === id);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  await getDb().insert(organization).values([{ id: 'o1', name: 'o1', slug: 'o1', createdAt: NOW }, { id: 'o2', name: 'o2', slug: 'o2', createdAt: NOW }]);
  await getDb().insert(devices).values([
    { id: 'b1', orgId: 'o1', name: 'A500', tokenHash: 'h1', lastSeenAt: NOW },
    { id: 'b3', orgId: 'o2', name: 'Other', tokenHash: 'h3', lastSeenAt: NOW },
  ]);
});
beforeEach(async () => {
  await getDb().delete(transfers);
  await getDb().delete(remoteRequests);
  await getDb().delete(amigaUploads);
});
afterAll(async () => { await closeDb(); await admin(`drop database if exists ${DB} with (force)`); });

describe('cancelJob', () => {
  it('to the Amiga: waiting and sending rows cancelled, what arrived stays, the board told once', async () => {
    await getDb().insert(transfers).values([
      tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(5_000), amigaDest: 'Work:T/a' }),
      tr('r2', { jobId: 'j1', status: 'sending', sizeBytes: 40_000, bytesSent: 16_384, amigaDest: 'Work:T/b' }),
      tr('r3', { jobId: 'j1', amigaDest: 'Work:T/c' }),
    ]);
    const v0 = await sendVersion('b1');
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await rowStatus('j1')).toEqual({ r1: 'delivered', r2: 'cancelled', r3: 'cancelled' });
    expect(await sendVersion('b1')).toBe(v0 + 1);
    // The board's next chunk of the row it was sending hears that it is over.
    expect(await recordChunk(getDb(), 'b1', 'r2', 32_768)).toEqual({ ok: false, status: 409 });
    expect(await jobOf('j1')).toMatchObject({ running: false, total: 3, done: 1, failed: [], cancelled: 2, cancel: { move: false, source: null } });
  });

  // Review Focus 4: a file arriving when Cancel hits.
  it('from the Amiga: waiting and taken gets withdrawn, the arriving file stopped', async () => {
    await getDb().insert(amigaUploads).values([{ id: 'u1', orgId: 'o1', deviceId: 'b1', path: 'In/x', sizeBytes: 40_000, receivedBytes: 16_384,
      amigaDate: '1.2.3', status: 'receiving', source: 'copy', expiresAt: later }]);
    await getDb().insert(amigaUploadChunks).values([{ uploadId: 'u1', offset: 0, data: new Uint8Array(16_384) }]);
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j2', status: 'fetching', uploadId: 'u1', activeAt: ago(500), target: target({ size: 40_000 }) }),
      rq('g2', { fetchId: 'j2', status: 'sent', sentAt: ago(1_000), target: target({ rel: ['y'] }) }),
      rq('g3', { fetchId: 'j2', target: target({ rel: ['z'] }) }),
      rq('g4', { fetchId: 'j2', status: 'done', answeredAt: ago(2_000), target: target({ rel: ['w'] }) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j2', NOW)).toEqual({ ok: true, cancelled: 3 });
    for (const id of ['g1', 'g2', 'g3']) expect(await reqOf(id)).toMatchObject({ status: 'failed', errorCode: 'cancelled', errorText: 'cancelled' });
    expect((await reqOf('g4')).status).toBe('done');
    expect((await getDb().select().from(amigaUploads).where(eq(amigaUploads.id, 'u1')))[0].status).toBe('deleted');
    expect(await getDb().select().from(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, 'u1'))).toEqual([]);
    expect(await storeChunk(getDb(), 'b1', 'u1', 16_384, new Uint8Array(16_384))).toEqual({ ok: false, status: 404 });
    // The get the board took but had not opened: Transfer's open is refused, so nothing of it arrives.
    expect(await openUpload(getDb(), { deviceId: 'b1', orgId: 'o1' }, { size: 10, date: '1.2.3', protection: 0, path: 'y', comment: '', request: 'g2' }))
      .toEqual({ ok: false, code: 'name' });
    expect(await jobOf('j2')).toMatchObject({ running: false, done: 1, failed: [], cancelled: 3 });
  });

  it('writes: waiting ones withdrawn; a drawer delete Transfer runs finishes (spec §6 limit)', async () => {
    await getDb().insert(remoteRequests).values([
      rq('w1', { fetchId: 'j3', kind: 'delete', amigaPath: 'Work:Big', status: 'sent', sentAt: ago(1_000), activeAt: ago(1_000), target: { label: 'Work:Big' } }),
      rq('w2', { fetchId: 'j3', kind: 'delete', amigaPath: 'Work:Old', target: { label: 'Work:Old' }, createdAt: ago(9_000) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j3', NOW)).toEqual({ ok: true, cancelled: 1 });
    expect((await reqOf('w1')).status).toBe('sent');
    expect(await reqOf('w2')).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    expect(await jobOf('j3')).toMatchObject({ running: true, cancel: { move: false, source: null } });
  });

  it('a move onto a volume keeps every source not yet removed', async () => {
    await getDb().insert(transfers).values([
      tr('m1', { jobId: 'j4', status: 'delivered', finishedAt: ago(4_000), amigaDest: 'Work:T/Pack/a', moveSource: 'STASH:/Pack', moveItem: 'Pack/a' }),
      tr('m2', { jobId: 'j4', amigaDest: 'Work:T/Pack/b', moveSource: 'STASH:/Pack', moveItem: 'Pack/b' }),
      // Every file of this source arrived, its removal not yet begun: it stays too (the safe side).
      tr('m3', { jobId: 'j4', status: 'delivered', finishedAt: ago(4_000), amigaDest: 'Work:T/Two/c', moveSource: 'STASH:/Two', moveItem: 'Two/c' }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j4', NOW)).toEqual({ ok: true, cancelled: 1 });
    expect((await getDb().select({ s: transfers.moveSource }).from(transfers).where(eq(transfers.jobId, 'j4'))).map((r) => r.s)).toEqual([null, null, null]);
    await settleMovesOfJob(getDb(), 'o1', 'j4');
    expect(await getDb().select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, 'j4'), ne(remoteRequests.kind, 'cancel')))).toEqual([]);
    expect(await jobOf('j4')).toMatchObject({ kind: 'move', running: false, total: 3, done: 2, cancel: { move: true, source: 'STASH:' } });
  });

  it('a move off a volume: its waiting removals withdrawn, its markers gone', async () => {
    const mv = { moveSource: 'NET:/b1/Work/Pack', moveSeen: { size: 10, date: 'd' } };
    await getDb().insert(remoteRequests).values([
      rq('g1', { fetchId: 'j5', status: 'done', amigaPath: 'Work:Pack/a', answeredAt: ago(3_000), target: target({ rel: ['Pack', 'a'], ...mv }) }),
      rq('g2', { fetchId: 'j5', amigaPath: 'Work:Pack/b', target: target({ rel: ['Pack', 'b'], ...mv }) }),
      rq('d1', { fetchId: 'j5', kind: 'delete', amigaPath: 'Work:Pack/z', target: { label: 'Work:Pack/z', one: true }, createdAt: ago(1_000) }),
    ]);
    expect(await cancelJob(getDb(), 'o1', 'j5', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await reqOf('d1')).toMatchObject({ status: 'failed', errorCode: 'cancelled' });
    for (const id of ['g1', 'g2']) expect((await reqOf(id)).target).not.toHaveProperty('moveSource');
    expect(await jobOf('j5')).toMatchObject({ kind: 'move', direction: 'from', running: false, cancel: { move: true, source: 'Work:Pack' } });
  });

  it('another org\'s job, or no such job: not found, and nothing changes', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    expect(await cancelJob(getDb(), 'o2', 'j1', NOW)).toEqual({ ok: false });
    expect(await cancelJob(getDb(), 'o1', 'nope', NOW)).toEqual({ ok: false });
    expect(await rowStatus('j1')).toEqual({ r1: 'queued' });
  });

  // Review Focus 3: Cancel racing the job's own end, or pressed twice.
  it('a job that finished on its own: nothing cancelled, no marker, no Cancelled words', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', status: 'delivered', finishedAt: ago(1_000), amigaDest: 'Work:a' })]);
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 0 });
    expect(await markers('j1')).toEqual([]);
    expect(await jobOf('j1')).toMatchObject({ cancel: null, cancelled: 0 });
  });
  it('pressed twice: the second cancels nothing and adds no second marker', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' }), tr('r2', { jobId: 'j1', amigaDest: 'Work:b', createdAt: ago(9_000) })]);
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 2 });
    expect(await cancelJob(getDb(), 'o1', 'j1', NOW)).toEqual({ ok: true, cancelled: 0 });
    expect(await markers('j1')).toHaveLength(1);
  });

  // Review Focus 2: two jobs at once.
  it('one job cancelled leaves another running job alone', async () => {
    await getDb().insert(transfers).values([tr('r1', { jobId: 'j1', amigaDest: 'Work:a' }), tr('x1', { jobId: 'jx', amigaDest: 'Work:b' })]);
    await getDb().insert(remoteRequests).values([rq('gx', { fetchId: 'jx', target: target() })]);
    await cancelJob(getDb(), 'o1', 'j1', NOW);
    expect(await rowStatus('jx')).toEqual({ x1: 'queued' });
    expect((await reqOf('gx')).status).toBe('waiting');
    expect(await jobOf('jx')).toMatchObject({ running: true, cancel: null });
  });

  it('the Queue job: the board\'s job-less waiting and sending rows, nothing of a Files job', async () => {
    await getDb().insert(transfers).values([tr('q1', {}), tr('q2', { status: 'sending', createdAt: ago(9_000) }), tr('r1', { jobId: 'j1', amigaDest: 'Work:a' })]);
    const queue = (await listJobs(getDb(), 'o1', NOW)).find((j) => j.kind === 'send')!;
    expect(await cancelJob(getDb(), 'o2', queue.id, NOW)).toEqual({ ok: false });
    expect(await cancelJob(getDb(), 'o1', queue.id, NOW)).toEqual({ ok: true, cancelled: 2 });
    const all = Object.fromEntries((await getDb().select().from(transfers)).map((r) => [r.id, r.status]));
    expect(all).toEqual({ q1: 'cancelled', q2: 'cancelled', r1: 'queued' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=$(WEBADF_PG_NAME=webadf-pg-e2e WEBADF_PG_PORT=55433 bash scripts/dev-db.sh start) pnpm test:db src/lib/files/job-cancel.db.test.ts`
Expected: FAIL — cannot resolve `./job-cancel`.

- [ ] **Step 3: `cancelQueueSends` in transfers.ts**

In `src/lib/transfers.ts`, directly after `cancelTransfer`, add:

```ts
/**
 * Cancel the rest of a board's plain Queue sends (the progress panel, spec 2026-11-01 §6): its job-less rows that wait
 * or move, as Delete in the Queue cancels one; the board hears it once. How many were cancelled.
 */
export async function cancelQueueSends(db: Db, orgId: string, deviceId: string, now = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const done = await tx.update(transfers).set({ status: 'cancelled', finishedAt: now })
      .where(and(eq(transfers.orgId, orgId), eq(transfers.deviceId, deviceId), isNull(transfers.jobId), inArray(transfers.status, ACTIVE)))
      .returning({ id: transfers.id });
    if (done.length) await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, deviceId));
    return done.length;
  });
}
```

(`isNull` is already imported there.)

- [ ] **Step 4: Write `job-cancel.ts`**

Create `src/lib/files/job-cancel.ts`:

```ts
// src/lib/files/job-cancel.ts
// Cancel the rest (spec 2026-11-01-progress-panel §6), each part as its single-row action already does it: queue rows
// to the Amiga cancelled (the board stops the one it sends; Transfer keeps nothing of it); gets withdrawn -- waiting ones
// never sent, taken ones refused at their open -- and a file arriving stopped as Delete stops an arriving STASH: row;
// waiting writes withdrawn (a drawer delete Transfer already runs finishes its drawer: Transfer has no stop for it). A
// move keeps every source not yet removed: its markers go, so no settle removes one from here. A `cancel` row records
// it for the card (kind 'cancel', never sent to a board). SERVER ONLY.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { cancelQueueSends } from '@/lib/transfers';
import { isWriteKind, type GetTarget } from '@/lib/remote-requests';
import { newRequestId } from '@/lib/remote-wire';
import { CANCEL_KIND, CANCELLED, commonDrawer, QUEUE_JOB } from './job-view';

const ACTIVE = ['queued', 'sending'];
export type CancelResult = { ok: true; cancelled: number } | { ok: false };

/** A Files path's parent (`STASH:/Games/Pack` → `STASH:/Games`, `STASH:/Pack` → `STASH:`). */
const filesParent = (p: string) => { const c = p.indexOf(':'); const s = p.lastIndexOf('/'); return s > c + 1 ? p.slice(0, s) : p.slice(0, c + 1); };
/** The path of the entry a queue row copies: the moved entry's parent and the row's `move_item` (which starts at its name). */
const fullSource = (source: string, item: string | null) => (item ? `${filesParent(source)}/${item}` : source);

export async function cancelJob(db: Db, orgId: string, id: string, now = new Date()): Promise<CancelResult> {
  if (id.startsWith(QUEUE_JOB)) {
    const end = id.lastIndexOf(':');
    if (end <= QUEUE_JOB.length) return { ok: false };
    const deviceId = id.slice(QUEUE_JOB.length, end);
    const [d] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
    if (!d) return { ok: false };
    return { ok: true, cancelled: await cancelQueueSends(db, orgId, deviceId, now) };
  }
  return db.transaction(async (tx) => {
    // The parts in settleMove's order (requests, then queue rows): a settle running meanwhile waits, then finds no markers.
    const reqs = await tx.select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, id), eq(remoteRequests.orgId, orgId)))
      .orderBy(remoteRequests.createdAt, remoteRequests.id).for('update');
    const rows = await tx.select().from(transfers).where(and(eq(transfers.jobId, id), eq(transfers.orgId, orgId)))
      .orderBy(transfers.createdAt, transfers.id).for('update');
    if (reqs.length === 0 && rows.length === 0) return { ok: false as const };
    const gets = reqs.filter((r) => r.kind === 'get');
    const markedSource = (r: (typeof reqs)[number]) => { const t = r.target as GetTarget | null; return t?.moveSource ?? t?.relay?.moveSource; };
    const marked = reqs.filter((r) => (r.kind === 'get' || r.kind === 'mkdir') && !!markedSource(r));
    const markedRows = rows.filter((x) => x.moveSource !== null);
    // What the card says once cancelled: whether it was a move, and where what did not go still is.
    const move = rows.some((x) => x.moveSource !== null || x.moveItem !== null) || gets.some((g) => (g.target as GetTarget).moveSeen !== undefined);
    const source = commonDrawer(markedRows.length ? markedRows.map((x) => fullSource(x.moveSource!, x.moveItem))
      : gets.filter((g) => (g.target as GetTarget).moveSeen !== undefined).map((g) => g.amigaPath));

    const withdraw = reqs.filter((r) => (r.kind === 'get' && ['waiting', 'sent', 'fetching'].includes(r.status))
      || (isWriteKind(r.kind) && r.status === 'waiting'));
    if (withdraw.length) {
      await tx.update(remoteRequests).set({ status: 'failed', errorCode: CANCELLED, errorText: CANCELLED, answeredAt: now })
        .where(inArray(remoteRequests.id, withdraw.map((r) => r.id)));
    }
    const arriving = withdraw.filter((r) => r.kind === 'get' && r.status === 'fetching' && r.uploadId).map((r) => r.uploadId!);
    if (arriving.length) {
      // The board's next chunk or close hears that it is gone (as deleteStash and releaseStaging do it).
      const hit = await tx.update(amigaUploads).set({ status: 'deleted' })
        .where(and(inArray(amigaUploads.id, arriving), eq(amigaUploads.orgId, orgId), eq(amigaUploads.status, 'receiving')))
        .returning({ id: amigaUploads.id });
      if (hit.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, hit.map((h) => h.id)));
    }
    const sending = rows.filter((x) => ACTIVE.includes(x.status));
    if (sending.length) {
      await tx.update(transfers).set({ status: 'cancelled', finishedAt: now })
        .where(and(inArray(transfers.id, sending.map((x) => x.id)), inArray(transfers.status, ACTIVE)));
      await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` })
        .where(inArray(devices.id, [...new Set(sending.map((x) => x.deviceId))]));
    }
    if (marked.length) {
      await tx.update(remoteRequests).set({ target: sql`(${remoteRequests.target} - 'moveSource') #- '{relay,moveSource}'` })
        .where(inArray(remoteRequests.id, marked.map((r) => r.id)));
    }
    if (markedRows.length) await tx.update(transfers).set({ moveSource: null }).where(inArray(transfers.id, markedRows.map((x) => x.id)));

    const cancelled = withdraw.length + sending.length;
    const stillRunning = reqs.some((r) => isWriteKind(r.kind) && (r.status === 'sent' || r.status === 'settling'));
    if ((cancelled > 0 || marked.length > 0 || markedRows.length > 0 || stillRunning) && !reqs.some((r) => r.kind === CANCEL_KIND)) {
      const relay = gets.map((g) => (g.target as GetTarget).relay).find((x) => !!x);
      const board = rows[0]?.deviceId ?? relay?.deviceId ?? reqs.find((r) => r.kind !== 'get')?.deviceId ?? reqs[0].deviceId;
      await tx.insert(remoteRequests).values({ id: newRequestId(), orgId, deviceId: board, kind: CANCEL_KIND, status: 'done', fetchId: id,
        target: { move, source: move ? source : null }, createdAt: now, answeredAt: now });
    }
    return { ok: true as const, cancelled };
  });
}
```

- [ ] **Step 5: Write the route**

Create `src/app/api/files/jobs/[id]/cancel/route.ts`:

```ts
// POST /api/files/jobs/<id>/cancel -- Cancel the rest (spec 2026-11-01-progress-panel §6): what of the job has not gone
// is withdrawn or stopped; what arrived stays. This org's jobs only; else 404. Pressing it again cancels nothing more.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { cancelJob } from '@/lib/files/job-cancel';

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const r = await cancelJob(getDb(), orgId, id, new Date());
  if (!r.ok) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(r, { headers: { 'cache-control': 'no-store' } });
}
```

- [ ] **Step 6: Run the DB tests**

Run: `TEST_DATABASE_URL=$(WEBADF_PG_NAME=webadf-pg-e2e WEBADF_PG_PORT=55433 bash scripts/dev-db.sh start) pnpm test:db src/lib/files/job-cancel.db.test.ts src/lib/files/jobs.db.test.ts src/lib/transfers.db.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/files/job-cancel.ts src/lib/files/job-cancel.db.test.ts "src/app/api/files/jobs/[id]/cancel/route.ts" src/lib/transfers.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git status
git add src/lib/files/job-cancel.ts src/lib/files/job-cancel.db.test.ts "src/app/api/files/jobs/[id]/cancel/route.ts" src/lib/transfers.ts
git commit -m "Progress panel: Cancel the rest per kind; a cancelled move keeps every source not yet removed"
```

---

### Task 4: The client jobs store (polling, track/watch, memory)

**Files:**
- Create: `src/lib/files/jobs-client.ts`
- Test: `src/lib/files/jobs-client.test.ts` (new)

**Interfaces:**
- Consumes: `JobView`, `Sample`, `FADE_MS`, `WINDOW_MS`, `isClean`, `resultWords` (Task 1).
- Produces: `POLL_MS = 2_000`, `OFFLINE_POLL_MS = 15_000`, `TRACK_MS = 10_000`, `OPEN_KEY`, `SEEN_KEY`, `SEEN_MAX = 50`; `readOpen(s)`, `readSeen(s)`; `nextDelay(jobs, { tracking, visible, failed }): number | null`; `type JobsAnswer = { jobs: JobView[] }`; `type JobsDeps`; `type JobsState = { jobs; samples: Record<string, Sample[]>; finishedSeenAt: Record<string, number>; open: boolean; seen: string[]; announce: string; signedOut: boolean }`; `createJobsStore(deps)` returning `{ getState, subscribe, start, stop, poke, onVisibility, track, watch, setOpen, dismiss, fadeFinished }`; `type JobsStore = ReturnType<typeof createJobsStore>`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/files/jobs-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJobsStore, nextDelay, OFFLINE_POLL_MS, OPEN_KEY, POLL_MS, SEEN_KEY, SEEN_MAX, TRACK_MS, type JobsDeps } from './jobs-client';
import type { JobView } from './job-view';

const job = (o: Partial<JobView> = {}): JobView => ({
  id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools', writeKind: null,
  total: 2, done: 0, failed: [], waiting: 2, skipped: 0, writes: [], offline: null, arrived: [],
  cancelled: 0, cancel: null, bytes: { total: 1000, done: 0 }, current: null, running: true,
  startedAt: '2026-11-01T10:00:00.000Z', finishedAt: null, ...o,
});
const finished = (o: Partial<JobView> = {}) => job({ running: false, waiting: 0, done: 2, finishedAt: '2026-11-01T10:00:05.000Z', ...o });
type Answer = JobView[] | 'signed-out' | null;

function harness(answers: Answer[], o: Partial<Pick<JobsDeps, 'visible' | 'storage'>> = {}) {
  let k = 0;
  const load = vi.fn(async () => {
    const a = answers[Math.min(k++, answers.length - 1)];
    return a === null || a === 'signed-out' ? a : { jobs: a };
  });
  const store = createJobsStore({
    load, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    visible: o.visible ?? (() => true), storage: o.storage ?? (() => null),
  });
  return { store, load };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('nextDelay (spec §3)', () => {
  it('2 s while a job runs, 15 s while every running job waits on an offline board, none otherwise', () => {
    const on = { tracking: false, visible: true, failed: false };
    expect(nextDelay([job()], on)).toBe(POLL_MS);
    expect(nextDelay([job({ offline: 'A500' })], on)).toBe(OFFLINE_POLL_MS);
    expect(nextDelay([job({ offline: 'A500' }), job({ id: 'j2' })], on)).toBe(POLL_MS);
    expect(nextDelay([finished()], on)).toBeNull();
    expect(nextDelay([], { ...on, tracking: true })).toBe(POLL_MS);
    expect(nextDelay([job()], { ...on, visible: false })).toBeNull();
    expect(nextDelay([], { ...on, failed: true })).toBe(OFFLINE_POLL_MS);
  });
});

describe('createJobsStore polling', () => {
  it('nothing runs: one load, then quiet', async () => {
    const { store, load } = harness([[]]);
    store.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('a running job: every 2 s, and quiet once it finished', async () => {
    const { store, load } = harness([[job()], [job()], [finished()]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('the board offline: every 15 s', async () => {
    const { store, load } = harness([[job({ offline: 'A500' })]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  // Review Focus 5: hidden, then shown.
  it('a hidden tab asks nothing; shown again it asks at once', async () => {
    let shown = true;
    const { store, load } = harness([[job()]], { visible: () => shown });
    store.start();
    await flush();
    shown = false;
    store.onVisibility();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
    shown = true;
    store.onVisibility();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('track: a job started here is asked for at once, every 2 s until it shows, at most 10 s', async () => {
    const { store, load } = harness([[]]);
    store.start();
    await flush();
    store.track('j9');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TRACK_MS + 20_000);
    expect(load).toHaveBeenCalledTimes(7);
  });
  it('track stops once the job shows', async () => {
    const { store, load } = harness([[], [finished({ id: 'j9' })]]);
    store.start();
    await flush();
    store.track('j9');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('a failed load is tried again after 15 s', async () => {
    const { store, load } = harness([null, [job()]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getState().jobs).toHaveLength(1);
  });
  it('signed out: it stops and says so', async () => {
    const { store, load } = harness(['signed-out']);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getState().signedOut).toBe(true);
  });
});

describe('createJobsStore state', () => {
  it('watch hears each answer with its job; unwatched, nothing more', async () => {
    const { store } = harness([[job()], [job({ done: 1, waiting: 1 })], [finished()]]);
    const heard: number[] = [];
    const stop = store.watch('j1', (j) => heard.push(j.done));
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heard).toEqual([0, 1]);
  });
  it('finishedSeenAt: when it was first seen finished, kept after', async () => {
    const { store } = harness([[finished()]]);
    store.start();
    await flush();
    const at = store.getState().finishedSeenAt.j1;
    expect(at).toBe(Date.now());
    vi.setSystemTime(Date.now() + 5_000);
    store.poke();
    await flush();
    expect(store.getState().finishedSeenAt.j1).toBe(at);
  });
  it('samples: a running job\'s bytes, the last 30 s only', async () => {
    const answers: Answer[] = Array.from({ length: 25 }, (_, k) => [job({ bytes: { total: 100_000, done: k * 1000 } })]);
    const { store } = harness(answers);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    const s = store.getState().samples.j1;
    expect(s[s.length - 1].done).toBe(20_000);
    expect(s.every((x) => x.at >= Date.now() - 30_000)).toBe(true);
  });
  it('announces once a job this page saw running finishes, with its result', async () => {
    const { store } = harness([[job()], [finished()]]);
    store.start();
    await flush();
    expect(store.getState().announce).toBe('');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getState().announce).toBe('Copied 2 to A500');
  });
  it('a job already finished when the page loads is not announced', async () => {
    const { store } = harness([[finished()]]);
    store.start();
    await flush();
    expect(store.getState().announce).toBe('');
  });
  it('fadeFinished: a clean finish is put away 6 s after it was first seen; a failure stays', async () => {
    const { store } = harness([[finished(), finished({ id: 'j2', failed: [{ name: 'a', reason: 'r' }] })]]);
    store.start();
    await flush();
    store.fadeFinished(Date.now() + 5_000);
    expect(store.getState().seen).toEqual([]);
    store.fadeFinished(Date.now() + 6_000);
    expect(store.getState().seen).toEqual(['j1']);
  });
});

describe('remembered per browser', () => {
  function memory() {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } };
  }
  it('open/closed and the cards put away survive a new store', async () => {
    const { m, s } = memory();
    const a = harness([[]], { storage: () => s }).store;
    a.start();
    a.setOpen(false);
    a.dismiss('j1');
    expect(m.get(OPEN_KEY)).toBe('0');
    expect(JSON.parse(m.get(SEEN_KEY)!)).toEqual(['j1']);
    const b = harness([[]], { storage: () => s }).store;
    b.start();
    expect(b.getState()).toMatchObject({ open: false, seen: ['j1'] });
  });
  it('keeps the last 50 put away', () => {
    const { s } = memory();
    const a = harness([[]], { storage: () => s }).store;
    for (let k = 0; k < SEEN_MAX + 5; k++) a.dismiss(`j${k}`);
    expect(a.getState().seen).toHaveLength(SEEN_MAX);
    expect(a.getState().seen[0]).toBe('j5');
  });
  // Review Focus 5: storage that throws (a private window).
  it('storage that throws changes nothing else', async () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const { store } = harness([[job()]], { storage: () => bad });
    store.start();
    await flush();
    expect(store.getState()).toMatchObject({ open: true, seen: [] });
    store.setOpen(false);
    store.dismiss('j1');
    expect(store.getState()).toMatchObject({ open: false, seen: ['j1'] });
    expect(store.getState().jobs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/files/jobs-client.test.ts`
Expected: FAIL — cannot resolve `./jobs-client`.

- [ ] **Step 3: Write `jobs-client.ts`**

Create `src/lib/files/jobs-client.ts`:

```ts
// src/lib/files/jobs-client.ts
// The progress panel's store (spec 2026-11-01-progress-panel §3): the org's jobs as GET /api/files/jobs answers them,
// asked once on load and then only while a job runs -- every 2 s while the page is visible, every 15 s while every
// running job waits on a board that is offline, never while the tab is hidden. Files tells it about a job it just
// started (track) and hears each answer for it (watch). The open/closed choice and the cards already put away are
// remembered per browser, a convenience: storage that throws or is empty changes nothing else. CLIENT-SAFE.
import { FADE_MS, isClean, resultWords, WINDOW_MS, type JobView, type Sample } from './job-view';

export const POLL_MS = 2_000;
export const OFFLINE_POLL_MS = 15_000;
/** A job this tab just started is looked for this long before the store stops asking for it. */
export const TRACK_MS = 10_000;
export const OPEN_KEY = 'webadf:transfers-open';
export const SEEN_KEY = 'webadf:transfers-seen';
export const SEEN_MAX = 50;

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export type JobsAnswer = { jobs: JobView[] };
export type JobsDeps = {
  /** One answer; 'signed-out' when the session is gone; null when there was none (network, 5xx). */
  load(): Promise<JobsAnswer | 'signed-out' | null>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  visible(): boolean;
  storage(): KeyStore | null;
};
export type JobsState = {
  jobs: JobView[];
  samples: Record<string, Sample[]>;
  finishedSeenAt: Record<string, number>;
  open: boolean;
  /** Cards closed, or faded after a clean finish: not shown again in this browser. */
  seen: string[];
  /** The polite live region's words: the last job this page saw running that finished. */
  announce: string;
  signedOut: boolean;
};

export function readOpen(s: KeyStore | null): boolean {
  try { return s?.getItem(OPEN_KEY) !== '0'; } catch { return true; }
}
export function readSeen(s: KeyStore | null): string[] {
  try {
    const v: unknown = JSON.parse(s?.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-SEEN_MAX) : [];
  } catch { return []; }
}
function save(s: KeyStore | null, key: string, value: string) {
  try { s?.setItem(key, value); } catch { /* not remembered; this page still has it */ }
}

/** How long until the next ask, or null for none (spec §3). A failed ask is tried again after OFFLINE_POLL_MS. */
export function nextDelay(jobs: JobView[], o: { tracking: boolean; visible: boolean; failed: boolean }): number | null {
  if (!o.visible) return null;
  if (o.failed) return OFFLINE_POLL_MS;
  const running = jobs.filter((j) => j.running);
  if (o.tracking || running.some((j) => !j.offline)) return POLL_MS;
  return running.length ? OFFLINE_POLL_MS : null;
}

export function createJobsStore(deps: JobsDeps) {
  let state: JobsState = { jobs: [], samples: {}, finishedSeenAt: {}, open: true, seen: [], announce: '', signedOut: false };
  const listeners = new Set<() => void>();
  const watchers = new Map<string, Set<(j: JobView) => void>>();
  const tracked = new Map<string, number>();
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = true;
  let failed = false;

  const set = (next: Partial<JobsState>) => { state = { ...state, ...next }; for (const l of listeners) l(); };
  const clear = () => { if (timer !== null) { deps.clearTimer(timer); timer = null; } };

  function schedule() {
    if (stopped || timer !== null || state.signedOut) return;
    const now = deps.now();
    for (const [id, until] of tracked) if (until <= now || state.jobs.some((j) => j.id === id)) tracked.delete(id);
    const ms = nextDelay(state.jobs, { tracking: tracked.size > 0, visible: deps.visible(), failed });
    if (ms !== null) timer = deps.setTimer(() => { timer = null; void tick(); }, ms);
  }

  function take(jobs: JobView[]) {
    const now = deps.now();
    const samples: Record<string, Sample[]> = {};
    const finishedSeenAt: Record<string, number> = {};
    let announce = state.announce;
    for (const j of jobs) {
      if (j.running && j.bytes) {
        samples[j.id] = [...(state.samples[j.id] ?? []), { at: now, done: j.bytes.done }].filter((s) => s.at >= now - WINDOW_MS);
      }
      if (!j.running) {
        finishedSeenAt[j.id] = state.finishedSeenAt[j.id] ?? now;
        if (state.jobs.some((x) => x.id === j.id && x.running)) announce = resultWords(j);
      }
    }
    set({ jobs, samples, finishedSeenAt, announce, signedOut: false });
    for (const j of jobs) for (const w of [...(watchers.get(j.id) ?? [])]) w(j);
  }

  async function tick() {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      const a = await deps.load();
      if (stopped) return;
      failed = a === null;
      if (a === 'signed-out') set({ signedOut: true });
      else if (a) take(a.jobs);
    } finally {
      inFlight = false;
      if (again) { again = false; void tick(); } else schedule();
    }
  }

  function dismiss(id: string) {
    const seen = [...state.seen.filter((x) => x !== id), id].slice(-SEEN_MAX);
    save(deps.storage(), SEEN_KEY, JSON.stringify(seen));
    set({ seen });
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start() {
      const s = deps.storage();
      set({ open: readOpen(s), seen: readSeen(s) });
      stopped = false;
      void tick();
    },
    stop() { stopped = true; clear(); },
    /** Ask now (after a Cancel), whatever the schedule. */
    poke() { clear(); void tick(); },
    /** The tab was hidden or shown: shown asks at once, hidden asks nothing until shown. */
    onVisibility() { clear(); if (deps.visible()) void tick(); },
    /** A job this tab just started: asked for now, and every POLL_MS until it shows (TRACK_MS at most). */
    track(id: string) { tracked.set(id, deps.now() + TRACK_MS); clear(); void tick(); },
    /** Hears every answer that holds job `id`, from the next one; the returned function stops it. */
    watch(id: string, fn: (j: JobView) => void) {
      const list = watchers.get(id) ?? new Set<(j: JobView) => void>();
      list.add(fn);
      watchers.set(id, list);
      return () => { list.delete(fn); if (list.size === 0) watchers.delete(id); };
    },
    setOpen(open: boolean) { save(deps.storage(), OPEN_KEY, open ? '1' : '0'); set({ open }); },
    dismiss,
    /** Puts away each clean finish seen finished FADE_MS ago or more (spec §3: it fades after 6 s). */
    fadeFinished(now: number) {
      for (const j of state.jobs) {
        const at = state.finishedSeenAt[j.id];
        if (!j.running && isClean(j) && at !== undefined && now - at >= FADE_MS && !state.seen.includes(j.id)) dismiss(j.id);
      }
    },
  };
}
export type JobsStore = ReturnType<typeof createJobsStore>;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/files/jobs-client.test.ts`
Expected: PASS. (If the "track" count differs by one, re-read the schedule: asks at 0, 2, 4, 6, 8 and 10 s after `track`, then the 10 s deadline has passed and nothing runs, so it stops — 1 + 6 = 7 loads. Fix the code, not the expectation, unless the spec's rule says otherwise.)

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/files/jobs-client.ts src/lib/files/jobs-client.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git status
git add src/lib/files/jobs-client.ts src/lib/files/jobs-client.test.ts
git commit -m "Progress panel: the jobs store asks only while a job runs, 2 s visible, 15 s offline, none hidden"
```

---

### Task 5: The panel on every page

**Files:**
- Create: `src/components/shell/jobs-provider.tsx`
- Create: `src/components/shell/transfers-panel.tsx`
- Modify: `src/app/(app)/layout.tsx` (wrap in `JobsProvider`, mount `TransfersPanel`)
- Modify: `src/app/globals.css:309-315` (`--transfers-base`)
- Modify: `src/components/ui/sonner.tsx:36-37` (toasts above the panel)
- Test: `e2e/transfers-panel.spec.ts` (new; first test)

**Interfaces:**
- Consumes: `createJobsStore`, `JobsStore`, `JobsAnswer`, `JobsState` (Task 4); every rule from Task 1; `GET /api/files/jobs` (Task 2); `POST /api/files/jobs/<id>/cancel` (Task 3); `Modal` (`src/components/ui/modal.tsx`); `isSignedOutAnswer`, `SIGNED_OUT_TEXT` (`src/lib/signed-out.ts`).
- Produces: `JobsProvider`, `useJobsStore(): JobsStore`, `useJobsState(): JobsState` (from `@/components/shell/jobs-provider`); `TransfersPanel`. Test ids: `transfers-panel` (the region), `transfers-pill`, `transfers-cards`, `transfers-card` (with `data-job-id`, `data-state` = `running|done|kept`), `transfers-card-title`, `transfers-card-line`, `transfers-card-now`, `transfers-card-result`, `transfers-card-failures`, `transfers-bar`, `transfers-cancel`, `transfers-close`, `transfers-cancel-dialog`, `transfers-cancel-text`, `transfers-cancel-yes`, `transfers-cancel-no`, `transfers-announce`. Elements marked `data-transfers-anchor` lift the panel above them (Task 6 marks the Files bar). CSS custom property `--transfers-top` on `<html>` while the panel shows.

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/transfers-panel.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { cleanupSeeded, pairDevice, setBrowse } from './device-helpers';
import { boardSays, boardServes, fakeBoardTiming, type BoardRequest, type FakeEntry, type VolumeNext } from './amiga-board';

/**
 * The progress panel (spec 2026-11-01-progress-panel): a Files job against a fake board that answers as firmware 1.23
 * with Transfer 2.6 -- the card on every page, its pill, what a reload keeps, and Cancel the rest.
 */

test.afterAll(cleanupSeeded);

const LIVE = 15_000;
const FW = '1.23.0+gabc1234';
const rowAt = (page: Page, side: 'left' | 'right', name: string) =>
  page.getByTestId(`pane-${side}`).locator(`[data-testid="pane-row"][data-name="${name}"]`);

function amiga(): Record<string, FakeEntry[]> {
  return {
    '': [{ name: 'Work', device: 'DH1:' }],
    'Work:': [{ name: 'Tools', dir: true }],
    'Work:Tools': [{ name: 'x.lha', data: Buffer.from('old x') }],
  };
}

async function writable(page: Page, request: APIRequestContext) {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request, 'A500');
  await boardSays(request, token, FW);
  await setBrowse(deviceId, { firmware: FW, rx: 'c', rxProto: 5, browseOn: true, writeOn: true });
  return { orgId, deviceId, token };
}

async function openFiles(page: Page, left: string, right: string, active: 'left' | 'right') {
  await page.goto(`/files?${new URLSearchParams({ left, right, active })}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="files-manager"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
}

function serving(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, maxMs = 120_000) {
  let done = false;
  const served: BoardRequest[] = [];
  const queue: VolumeNext[] = [];
  const run = boardServes(request, token, fs, () => done, served, maxMs, { queue });
  return { served, queue, stop: async () => { done = true; return run; } };
}

/** A STASH: drawer Pack holding `names` (the zone drops into STASH:; the ops route moves them in), the left pane in STASH:. */
async function stashPack(page: Page, names: string[]) {
  await page.getByTestId('files-stash-input').setInputFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await expect(rowAt(page, 'left', names[names.length - 1])).toBeVisible({ timeout: LIVE });
  expect((await page.request.post('/api/files/ops', { data: { op: 'makedir', dest: 'STASH:', name: 'Pack' } })).ok()).toBe(true);
  expect((await page.request.post('/api/files/ops', { data: { op: 'move', sources: names.map((n) => `STASH:/${n}`), dest: 'STASH:/Pack', onClash: 'ask' } })).ok()).toBe(true);
  await page.getByTestId('files-refresh').click();
  await expect(rowAt(page, 'left', 'Pack')).toBeVisible({ timeout: LIVE });
}

test('a copy onto a volume shows in the panel, on the Library page too; collapsed stays collapsed after a reload', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt']);
    fakeBoardTiming.queueHeld = true;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const panel = page.getByRole('region', { name: 'Transfers' });
    const card = panel.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-title')).toHaveText('Copying to A500 · Work:Tools/Pack', { timeout: LIVE });
    await expect(card.getByTestId('transfers-card-line')).toContainText('0 of 2 files');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await expect(card.getByTestId('transfers-cancel')).toHaveText('Cancel the rest');

    // Collapsed: the pill alone -- and so after a reload, and on another page.
    const pill = page.getByTestId('transfers-pill');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    await expect(pill).toHaveText('1 job · 0 %');
    await expect(page.getByTestId('transfers-cards')).toBeHidden();
    await page.reload();
    await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: LIVE });
    await page.goto('/library');
    await expect(pill).toHaveText('1 job · 0 %', { timeout: LIVE });
    await pill.click();
    await expect(panel.getByTestId('transfers-card-title').first()).toHaveText('Copying to A500 · Work:Tools/Pack');

    fakeBoardTiming.queueHeld = false;
    await expect(panel.getByTestId('transfers-card-result').first()).toHaveText('Copied 2 to A500', { timeout: 30_000 });
    await expect.poll(() => (fs['Work:Tools/Pack'] ?? []).map((e) => e.name).sort(), { timeout: LIVE }).toEqual(['one.txt', 'two.txt']);
  } finally { fakeBoardTiming.queueHeld = false; await board.stop(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/transfers-panel.spec.ts --reporter=line`
Expected: FAIL — no region named "Transfers".

- [ ] **Step 3: The provider**

Create `src/components/shell/jobs-provider.tsx`:

```tsx
'use client';
// The jobs store for every page (spec 2026-11-01-progress-panel §3): one per app layout, started on mount, asking
// GET /api/files/jobs as jobs-client.ts decides. The panel reads it; Files tells it about the jobs it starts.
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { createJobsStore, type JobsAnswer, type JobsState, type JobsStore } from '@/lib/files/jobs-client';
import { isSignedOutAnswer } from '@/lib/signed-out';

const JobsContext = createContext<JobsStore | null>(null);

async function loadJobs(): Promise<JobsAnswer | 'signed-out' | null> {
  let res: Response;
  try { res = await fetch('/api/files/jobs', { cache: 'no-store' }); } catch { return null; }
  if (isSignedOutAnswer(res)) return 'signed-out';
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as JobsAnswer | null;
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createJobsStore({
    load: loadJobs,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (t) => window.clearTimeout(t as number),
    visible: () => document.visibilityState === 'visible',
    storage: () => { try { return window.localStorage; } catch { return null; } },
  }));
  useEffect(() => {
    store.start();
    const onVisibility = () => store.onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); store.stop(); };
  }, [store]);
  return <JobsContext.Provider value={store}>{children}</JobsContext.Provider>;
}

export function useJobsStore(): JobsStore {
  const s = useContext(JobsContext);
  if (!s) throw new Error('useJobsStore needs the app layout\'s JobsProvider');
  return s;
}

export function useJobsState(): JobsState {
  const s = useJobsStore();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}
```

- [ ] **Step 4: The panel**

Create `src/components/shell/transfers-panel.tsx`:

```tsx
'use client';
// The progress panel (spec 2026-11-01-progress-panel §3, §5, §6): every page's view of the org's running Files jobs.
// From lg bottom right; below it a full-width strip above the tab bar; lifted above anything marked
// data-transfers-anchor (the Files bar). Collapsed, a pill; open, one card per job, newest first. A region named
// "Transfers"; each bar a progressbar; a finished job is announced once, politely; Cancel asks first. z-30: a dialog
// (z-50) always covers it. Toasts sit above it (--transfers-top, read by the Toaster's offset).
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { isSignedOutAnswer, SIGNED_OUT_TEXT } from '@/lib/signed-out';
import {
  barOf, canCancel, cardShown, confirmWords, failureList, isClean, jobLine, jobNow, jobTitle, panelLift, pillWords, resultWords, timeLeft,
  type JobView, type Sample,
} from '@/lib/files/job-view';
import { useJobsState, useJobsStore } from './jobs-provider';

const CANCEL_FAILED = 'Could not cancel — try again.';

export function TransfersPanel() {
  const store = useJobsStore();
  const st = useJobsState();
  const [now, setNow] = useState(() => Date.now());
  const [lift, setLift] = useState(0);
  const [asking, setAsking] = useState<JobView | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const box = useRef<HTMLElement>(null);
  const seen = new Set(st.seen);
  const shown = st.jobs.filter((j) => cardShown(j, { finishedSeenAt: st.finishedSeenAt[j.id] ?? null, dismissed: seen.has(j.id), now }));
  const hasCards = shown.length > 0;

  // While cards show: the clock for the fade and the estimate, and where the panel sits (above an anchor on screen).
  useEffect(() => {
    if (!hasCards) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const tops = [...document.querySelectorAll('[data-transfers-anchor]')].map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0).map((r) => r.top);
        setLift(panelLift(tops, window.innerHeight));
        const el = box.current;
        if (el) document.documentElement.style.setProperty('--transfers-top', `${Math.ceil(window.innerHeight - el.getBoundingClientRect().top + 8)}px`);
      });
    };
    const each = () => { const t = Date.now(); setNow(t); store.fadeFinished(t); measure(); };
    measure();
    const timer = window.setInterval(each, 1000);
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      document.documentElement.style.removeProperty('--transfers-top');
    };
  }, [hasCards, store]);

  async function cancel(j: JobView) {
    setCancelling(true);
    try {
      const res = await fetch(`/api/files/jobs/${encodeURIComponent(j.id)}/cancel`, { method: 'POST' });
      if (isSignedOutAnswer(res)) toast.error(SIGNED_OUT_TEXT);
      else if (!res.ok) toast.error(CANCEL_FAILED);
    } catch {
      toast.error(CANCEL_FAILED);
    } finally {
      setCancelling(false);
      setAsking(null);
      store.poke();
    }
  }

  const pill = pillWords(shown);
  return (
    <>
      <p className="sr-only" aria-live="polite" data-testid="transfers-announce">{st.announce}</p>
      {hasCards && (
        <section ref={box} role="region" aria-label="Transfers" data-testid="transfers-panel"
                 className="fixed right-6 z-30 flex w-[360px] flex-col gap-2 max-lg:left-4 max-lg:right-4 max-lg:w-auto"
                 style={{ bottom: `max(var(--transfers-base), ${lift}px)` }}>
          <button type="button" data-testid="transfers-pill" aria-expanded={st.open} aria-controls="transfers-cards"
                  aria-label={`${st.open ? 'Hide' : 'Show'} transfers: ${pill}`} onClick={() => store.setOpen(!st.open)}
                  className="min-h-11 self-end rounded-full border px-4 text-[13px] font-medium shadow-sm focus-visible:outline-2 focus-visible:outline-(--ring) max-lg:self-stretch lg:min-h-9"
                  style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
            {pill}
          </button>
          <ul id="transfers-cards" data-testid="transfers-cards" hidden={!st.open}
              className="flex max-h-[min(60vh,480px)] flex-col gap-2 overflow-y-auto">
            {st.signedOut && (
              <li className="rounded-[14px] border p-3 text-[13px]" style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
                {SIGNED_OUT_TEXT}
              </li>
            )}
            {shown.map((j) => (
              <JobCard key={j.id} j={j} samples={st.samples[j.id] ?? []} now={now} onCancel={() => setAsking(j)} onClose={() => store.dismiss(j.id)} />
            ))}
          </ul>
        </section>
      )}
      {asking && (
        <Modal open onOpenChange={(o) => { if (!o) setAsking(null); }} title="Cancel the rest?" width={440}
               testId="transfers-cancel-dialog" closeTestId="transfers-cancel-close" dismissible={!cancelling}
               footer={(
                 <>
                   <Button variant="destructive" data-testid="transfers-cancel-yes" disabled={cancelling} onClick={() => void cancel(asking)}>
                     Cancel the rest
                   </Button>
                   <Button variant="outline" data-testid="transfers-cancel-no" disabled={cancelling} onClick={() => setAsking(null)}>
                     Keep going
                   </Button>
                 </>
               )}>
          <p data-testid="transfers-cancel-text" className="px-6 py-4 text-[14px]" style={{ color: 'var(--ink)' }}>{confirmWords(asking)}</p>
        </Modal>
      )}
    </>
  );
}

function JobCard({ j, samples, now, onCancel, onClose }: { j: JobView; samples: Sample[]; now: number; onCancel(): void; onClose(): void }) {
  const title = jobTitle(j);
  const bar = barOf(j);
  const line2 = jobNow(j);
  const failures = failureList(j);
  return (
    <li data-testid="transfers-card" data-job-id={j.id} data-state={j.running ? 'running' : isClean(j) ? 'done' : 'kept'}
        className="rounded-[14px] border p-3 text-[13px] shadow-sm"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
      <div className="flex items-start gap-2">
        <p data-testid="transfers-card-title" className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{title}</p>
        {!j.running && (
          <button type="button" data-testid="transfers-close" aria-label={`Close: ${title}`} onClick={onClose}
                  className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-[10px] hover:bg-[var(--track)] focus-visible:outline-2 focus-visible:outline-(--ring)"
                  style={{ color: 'var(--muted)' }}>
            <XIcon className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {j.running ? (
        <>
          <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.value} data-testid="transfers-bar"
               className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
            <div className="h-full rounded-full transition-[width]" style={{ width: `${bar.value}%`, background: 'var(--ink)' }} />
          </div>
          <p data-testid="transfers-card-line" className="mt-1.5" style={{ color: 'var(--muted)' }}>{jobLine(j, timeLeft(samples, j, now))}</p>
          {line2 && <p data-testid="transfers-card-now" className="truncate" style={{ color: 'var(--muted)' }}>{line2}</p>}
          {canCancel(j) && (
            <Button size="sm" variant="outline" className="mt-2 max-lg:min-h-11" data-testid="transfers-cancel" onClick={onCancel}>
              Cancel the rest
            </Button>
          )}
        </>
      ) : (
        <>
          <p data-testid="transfers-card-result" className="mt-1 [overflow-wrap:anywhere]">{resultWords(j)}</p>
          {failures.length > 0 && (
            <ul data-testid="transfers-card-failures" className="mt-1 list-disc pl-5" style={{ color: 'var(--muted)' }}>
              {failures.map((f, k) => <li key={k} className="[overflow-wrap:anywhere]">{f}</li>)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}
```

- [ ] **Step 5: Mount it in the app layout**

In `src/app/(app)/layout.tsx`, add the imports

```ts
import { JobsProvider } from "@/components/shell/jobs-provider";
import { TransfersPanel } from "@/components/shell/transfers-panel";
```

and change the returned fragment from

```tsx
  return (
    <>
      <LiveRefresh initial={fingerprint} />
```

to

```tsx
  return (
    <JobsProvider>
      <LiveRefresh initial={fingerprint} />
```

and its end from

```tsx
        {children}
      </div>
    </>
  );
```

to

```tsx
        {children}
      </div>
      {/* The progress panel (spec 2026-11-01-progress-panel): every page, from the jobs store above. */}
      <TransfersPanel />
    </JobsProvider>
  );
```

- [ ] **Step 6: Its base offset, and toasts above it**

In `src/app/globals.css`, inside the `:root` block after `--toast-bottom:  24px; …` add:

```css
  --transfers-base: 24px;     /* the progress panel's bottom from lg; below lg it clears the tab bar (spec 2026-11-01 §3) */
```

and change the media block below it to:

```css
@media (width < 64rem) {
  :root {
    --toast-bottom: calc(4.75rem + env(safe-area-inset-bottom));
    --transfers-base: calc(4.5rem + env(safe-area-inset-bottom) + 8px);
  }
}
```

In `src/components/ui/sonner.tsx` change

```tsx
      offset={{ bottom: "var(--toast-bottom)" }}
      mobileOffset={{ bottom: "calc(4.75rem + env(safe-area-inset-bottom))" }}
```

to

```tsx
      // Above the progress panel while it shows (--transfers-top, set by transfers-panel.tsx).
      offset={{ bottom: "max(var(--toast-bottom), var(--transfers-top, 0px))" }}
      mobileOffset={{ bottom: "max(calc(4.75rem + env(safe-area-inset-bottom)), var(--transfers-top, 0px))" }}
```

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/components/shell/jobs-provider.tsx src/components/shell/transfers-panel.tsx "src/app/(app)/layout.tsx" src/components/ui/sonner.tsx`
Expected: no errors (in particular no `react-hooks/set-state-in-effect`: every setter runs in a timer, rAF or listener).

- [ ] **Step 8: Run the e2e test**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/transfers-panel.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git status
git add src/components/shell/jobs-provider.tsx src/components/shell/transfers-panel.tsx "src/app/(app)/layout.tsx" src/app/globals.css src/components/ui/sonner.tsx e2e/transfers-panel.spec.ts
git commit -m "Progress panel on every page: a Transfers region with a card per job, a remembered pill, toasts above it"
```

---

### Task 6: Files hands its jobs to the panel

**Files:**
- Modify: `src/components/files/files-manager.tsx` (imports `:37`, `:52`; `OFFLINE_POLL_MS` `:167-168`; `fetchLines` `:342-344`; `setBusy` `:340`; `fetchTimers` `:378-379`; unmount effect `:511-521`; `readyToCopy` `:927`; `readyInto` `:945`; `showFetchLine` `:967-974`; `watchFetch` `:976-1024`; the files-bar div `:1745`; the status row `:1781-1784`)
- Modify: `src/components/files/button-bank.tsx:22`
- Modify: `e2e/files-net-writes.spec.ts`, `e2e/files-net-volumes.spec.ts`, `e2e/files-net-volumes.mobile.spec.ts`

**Interfaces:**
- Consumes: `useJobsStore()` → `track(id)`, `watch(id, fn)` (Tasks 4-5); `JobView` (Task 1).
- Produces: the Files bar and the bank carry `data-transfers-anchor`; the status row (`files-busy`) shows only Files' own short operations and notes, never a NET: job's line.

- [ ] **Step 1: Point the e2e specs at the panel's card (its words differ from the old status line), and add the phone strip check**

In `e2e/files-net-writes.spec.ts`:
1. Replace `const busy = (page: Page) => page.getByTestId('files-busy');` with

```ts
/** The newest card of the progress panel (spec 2026-11-01-progress-panel): where a job's progress and result are said. */
const busy = (page: Page) => page.getByTestId('transfers-card').first();
```

2. Replace these assertions (the card counts files ended, and says offline its own way):
   - `await expect(busy(page)).toContainText('Copying 1 of 1 to A500', { timeout: LIVE });` → `await expect(busy(page)).toContainText('0 of 1 file', { timeout: LIVE });`
   - `await expect(busy(page)).toContainText('Copying 1 of 1 to A500… — A500 is offline', { timeout: LIVE });` → `await expect(busy(page)).toContainText('Waiting for A500 (offline)', { timeout: LIVE });`
   - both `await expect(busy(page)).toContainText('Copying 1 of 2 to A500', { timeout: LIVE });` → `await expect(busy(page)).toContainText('0 of 2 files', { timeout: LIVE });`
3. In the comment above the offline test, change "the status row says so (and asks every 15 s rather than every second)" to "the panel's card says so (and the panel asks every 15 s rather than every 2 s)".

In `e2e/files-net-volumes.spec.ts` add after the imports

```ts
/** The newest card of the progress panel (spec 2026-11-01-progress-panel). */
const card = (page: Page) => page.getByTestId('transfers-card').first();
```

then replace every `page.getByTestId('files-busy')` with `card(page)`, and change `toContainText(/Copying \d of 2 from A500|Copied 2/, { timeout: LIVE })` to `toContainText(/\d of 2 files|Copied 2/, { timeout: LIVE })`.

In `e2e/files-net-volumes.mobile.spec.ts`, in 'at 390: Copy to… takes a file out of a volume into STASH:', replace

```ts
  await expect(page.getByTestId('files-busy')).toContainText('Copied 1', { timeout: 30_000 });
```

with

```ts
  await expect(page.getByTestId('transfers-card').first()).toContainText('Copied 1', { timeout: 30_000 });
  // At 390 the panel is a strip above the Files bar, never over it (spec §3).
  await expect.poll(async () => {
    const p = await page.getByTestId('transfers-panel').boundingBox();
    const bar = await page.locator('.files-bar').boundingBox();
    return !!p && !!bar && p.y + p.height <= bar.y + 1;
  }, { timeout: 5_000 }).toBe(true);
```

- [ ] **Step 2: Run the migrated mobile spec to see it fail**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files-net-volumes.mobile.spec.ts --reporter=line`
Expected: FAIL on the strip check — the Files bar is not an anchor yet, so the panel sits over it.

- [ ] **Step 3: Mark the anchors**

In `src/components/files/button-bank.tsx` change

```tsx
    <div data-testid="files-bank" className="grid grid-cols-[120px_minmax(0,1fr)] border-t max-lg:hidden"
```

to

```tsx
    <div data-testid="files-bank" data-transfers-anchor="" className="grid grid-cols-[120px_minmax(0,1fr)] border-t max-lg:hidden"
```

In `src/components/files/files-manager.tsx` change

```tsx
        <div className="files-bar max-lg:rounded-b-[20px] lg:contents" style={{ background: 'var(--surface-2)' }}>
```

to

```tsx
        {/* data-transfers-anchor: the progress panel sits above the bank (lg) or this bar (below lg), never over them. */}
        <div data-transfers-anchor="" className="files-bar max-lg:rounded-b-[20px] lg:contents" style={{ background: 'var(--surface-2)' }}>
```

- [ ] **Step 4: Hand the jobs to the store, drop the NET: line**

In `src/components/files/files-manager.tsx`:

1. Imports: remove `jobStatus, ` from the `@/lib/files/manager-rules` import list; add

```ts
import { useJobsStore } from '@/components/shell/jobs-provider';
```

2. Delete

```ts
/** How often a job's progress is asked while a board it waits on is offline (item 14). */
const OFFLINE_POLL_MS = 15_000;
```

3. Replace

```ts
  const setBusy = (label: string | null) => { busyNow.current = label; setOpBusy(label); };
  // Copies out of NET: volumes, as the board fetches them (spec 2026-10-30 §4.5): one status line each, after the busy
  // line. Several may run at once (they queue on the board); a finished one's summary stays until the next one starts.
  const [fetchLines, setFetchLines] = useState<{ id: string; line: string; finished: boolean }[]>([]);
```

with

```ts
  // A NET: job's progress is the progress panel's (spec 2026-11-01-progress-panel); the status row keeps Files' own
  // short operations and a note of why one could not start (a drawer that could not be read), until the next starts.
  const [note, setNote] = useState<string | null>(null);
  const setBusy = (label: string | null) => { busyNow.current = label; setOpBusy(label); if (label !== null) setNote(null); };
  const jobsStore = useJobsStore();
```

4. Replace

```ts
  // The progress polls' timers (watchFetch), cleared on unmount.
  const fetchTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
```

with

```ts
  // The jobs this manager listens to (watchFetch), let go on unmount.
  const watchStops = useRef(new Set<() => void>());
```

5. In the mount effect replace

```ts
    const timers = fetchTimers.current;
    return () => { alive.current = false; timers.forEach(clearTimeout); timers.clear(); };
```

with

```ts
    const stops = watchStops.current;
    return () => { alive.current = false; stops.forEach((stop) => stop()); stops.clear(); };
```

6. In `readyToCopy` replace `if (failed) showFetchLine(\`walk-${Date.now()}\`, failed, true);` with `if (failed) setNote(failed);`.
7. In `readyInto` replace `showFetchLine(\`into-${Date.now()}\`, 'gone' in r ? GONE : r.error, true);` with `setNote('gone' in r ? GONE : r.error);`.
8. Delete the whole `showFetchLine` function and its doc comment.
9. Replace the whole `watchFetch` function and its doc comment with:

```ts
  /**
   * A job the board carries out (a copy out of a volume, §4.5; phase 2's copies onto a volume and its writes): the
   * progress panel shows it (spec 2026-11-01-progress-panel), from the jobs store this tells about it now. Here only
   * what the panes do: a pane at the destination re-reads while files arrive there, both sides read again once it is
   * through, and `then` hears the last progress (Download, P8). The busy lock is not held: the person may go on.
   */
  function watchFetch(f: Fetching, dest: string, then?: (p: { done: number; arrived: string[] }) => void) {
    let first = true;
    const sides = ['left', 'right'] as const;
    const stop = jobsStore.watch(f.id, (j) => {
      if (!alive.current) return;
      const { panes: cur } = latest.current;
      // A copy onto a volume (phase 2, spec 2026-10-31 §4.1): a pane at its destination, or at a drawer above it, shows
      // its files arriving at once (A500 bench 2026-10-31); their marks keep it re-reading (netPollMs) until they are
      // through. Between boards a pane there without an arriving mark yet is read again each answer (review I-1).
      if (j.running && j.direction === 'to') {
        for (const side of sides) if (arrivesIn(cur[side].path, dest) && (first || netPollMs(cur[side].listing) === null)) void refresh(side);
      }
      first = false;
      if (j.running) return;
      stop();
      watchStops.current.delete(stop);
      // A job that changed the Amiga's disks changed drawers on both sides maybe: both read again (the server let their
      // memory go); where the copy arrived the Amiga is asked afresh. A copy out of a volume changed only its destination.
      if (j.writes.length || j.direction === 'to') {
        for (const side of sides) void load(side, cur[side].path, { fresh: j.direction === 'to' && arrivesIn(cur[side].path, dest) });
      } else for (const side of sides) if (cur[side].path === dest) void refresh(side);
      then?.(j);
    });
    watchStops.current.add(stop);
    jobsStore.track(f.id);
  }
```

10. Replace the status row's content

```tsx
          {/* The one status row (§2.3): progress such as "Copying 3 of 12…". */}
          <p role="status" id="files-busy" data-testid="files-busy"
             className="px-3 py-0.5 text-[12px] max-lg:pb-2 max-lg:text-center max-lg:empty:hidden lg:min-h-[22px] lg:border-t"
             style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>{busy ?? fetchLines.map((x) => x.line).join(' · ')}</p>
```

with

```tsx
          {/* The one status row (§2.3): Files' own operation running ("Copying 3 items…"), or why one could not start.
              A NET: job's progress is the progress panel's (spec 2026-11-01-progress-panel). */}
          <p role="status" id="files-busy" data-testid="files-busy"
             className="px-3 py-0.5 text-[12px] max-lg:pb-2 max-lg:text-center max-lg:empty:hidden lg:min-h-[22px] lg:border-t"
             style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>{busy ?? note ?? ''}</p>
```

11. Search the file for any remaining `fetchLines`, `showFetchLine`, `fetchTimers`, `OFFLINE_POLL_MS`: there must be none. Keep `isSignedOutAnswer`/`SIGNED_OUT_TEXT` (still used by `post`).

- [ ] **Step 5: Typecheck, lint and the unit suite**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/components/files/files-manager.tsx src/components/files/button-bank.tsx && pnpm vitest run src/components/files src/lib/files`
Expected: no errors; PASS.

- [ ] **Step 6: Run the migrated e2e specs (three separate runs, each under 9 minutes)**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files-net-volumes.spec.ts e2e/files-net-volumes.mobile.spec.ts --reporter=line`
Expected: PASS.

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files-net-writes.spec.ts --reporter=line`
Expected: PASS. If one run would pass 9 minutes, split it: `-g "writing off|Makedir|Delete asks|big drawer|clash answer"` then `-g "offline|empty STASH|drawer copied|Move a volume|between two volumes"`.

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files.spec.ts e2e/files-stash.spec.ts e2e/transfers-panel.spec.ts --reporter=line`
Expected: PASS (the status row still shows Files' own busy labels; its box is unchanged when empty).

- [ ] **Step 7: Commit**

```bash
git status
git add src/components/files/files-manager.tsx src/components/files/button-bank.tsx e2e/files-net-writes.spec.ts e2e/files-net-volumes.spec.ts e2e/files-net-volumes.mobile.spec.ts
git commit -m "Files hands its NET: jobs to the progress panel; the status row keeps only Files' own operations"
```

---

### Task 7: Cancel end to end, and the help says it

**Files:**
- Modify: `e2e/amiga-board.ts:197-201` (`fakeBoardTiming.queueLimit`), `:316` (`boardServes`)
- Modify: `e2e/transfers-panel.spec.ts` (two tests)
- Modify: `src/lib/help/topics.tsx` (the `files` topic, and its Sources comment)
- Test: `src/lib/help/topics.test.ts` (one `it`)

**Interfaces:**
- Consumes: everything above; `boardQueue(request, token): Promise<string>` (e2e/amiga-board.ts).
- Produces: `fakeBoardTiming.queueLimit: number` (default `Infinity`): the fake board takes queue files only while it has taken fewer than this in the current `serving()` run.

- [ ] **Step 1: Write the failing help test**

In `src/lib/help/topics.test.ts`, inside `describe('help topics say what the app really does', () => {`, add:

```ts
  it('files says where progress shows: the Transfers panel on every page, and what Cancel the rest keeps (spec 2026-11-01)', () => {
    const b = bodyText('files').replace(/\s+/g, ' ');
    for (const w of ['Transfers', 'on every page', 'Cancel the rest', 'What has arrived stays', 'a move keeps its sources']) expect(b).toContain(w);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/help/topics.test.ts`
Expected: FAIL — `files` does not contain "Transfers".

- [ ] **Step 3: Write the help paragraph**

In `src/lib/help/topics.tsx`, in the `files` topic body, insert directly after the paragraph that begins `<strong>The Amiga&apos;s own disks.</strong>`:

```tsx
        <p>
          <strong>Progress.</strong> Copies and moves to and from the Amiga, its deletes and changes, and files sent to it
          show in the <em>Transfers</em> panel at the bottom right, on every page: a bar, the files and megabytes so far
          and, after a few seconds, the time left. <em>Cancel the rest</em> stops what has not gone yet. What has arrived
          stays, and a move keeps its sources.
        </p>
```

and add to the `// Sources:` comment lines directly above `files: {` (create the comment if the topic has none):

```ts
  // Progress: spec docs/superpowers/specs/2026-11-01-progress-panel-design.md; src/components/shell/transfers-panel.tsx,
  // src/lib/files/job-view.ts (the words), src/lib/files/job-cancel.ts (what Cancel the rest stops and keeps).
```

- [ ] **Step 4: Run the help tests**

Run: `pnpm vitest run src/lib/help/topics.test.ts`
Expected: PASS (files stays ≤ 415 words; no banned word).

- [ ] **Step 5: Let the fake board stop after N queue files**

In `e2e/amiga-board.ts`, extend `fakeBoardTiming`'s type and default:

```ts
export const fakeBoardTiming: { delMs: number; delBeforeMs: number; delEvery: number; queueHeld: boolean;
  /** The board takes queue files only while it has taken fewer than this in the current boardServes run. */
  queueLimit: number;
  /** Called before the fake Transfer answers each request: a test changes the Amiga mid-operation (spec §9). */
  onRequest: ((r: BoardRequest) => void) | null;
  /** Awaited between a GET's last chunk and its close: a test holds a file on its way up. */
  beforeClose: ((r: BoardRequest) => Promise<void>) | null } = { delMs: 0, delBeforeMs: 0, delEvery: 50, queueHeld: false, queueLimit: Infinity, onRequest: null, beforeClose: null };
```

and in `boardServes` change

```ts
    if (opts.queue && !fakeBoardTiming.queueHeld) { const t = await boardTakesVolumeNext(request, token, fs); if (t) opts.queue.push(t); }
```

to

```ts
    if (opts.queue && !fakeBoardTiming.queueHeld && opts.queue.length < fakeBoardTiming.queueLimit) {
      const t = await boardTakesVolumeNext(request, token, fs);
      if (t) opts.queue.push(t);
    }
```

- [ ] **Step 6: Write the failing e2e tests**

In `e2e/transfers-panel.spec.ts` add `boardQueue` to the `./amiga-board` import, and append:

```ts
test('on Files a card fills, finishes and fades; the status row does not say it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt']);
    fakeBoardTiming.queueLimit = 1;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const card = page.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-line')).toContainText('1 of 2 files', { timeout: LIVE });
    expect(Number(await card.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(page.getByTestId('files-busy')).toHaveText('');
    fakeBoardTiming.queueLimit = Infinity;
    await expect(card.getByTestId('transfers-card-result')).toHaveText('Copied 2 to A500', { timeout: 30_000 });
    await expect(page.getByTestId('transfers-announce')).toHaveText('Copied 2 to A500');
    // A clean finish fades after 6 s.
    await expect(page.getByTestId('transfers-card')).toHaveCount(0, { timeout: 12_000 });
  } finally { fakeBoardTiming.queueLimit = Infinity; await board.stop(); }
});

test('Cancel the rest asks first; what arrived stays, the rest never goes, and the card stays', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { deviceId, token } = await writable(page, request);
  const fs = amiga();
  const board = serving(request, token, fs);
  try {
    await openFiles(page, 'STASH:', `NET:/${deviceId}/Work/Tools`, 'left');
    await expect(rowAt(page, 'right', 'x.lha')).toBeVisible({ timeout: LIVE });
    await stashPack(page, ['one.txt', 'two.txt', 'three.txt']);
    fakeBoardTiming.queueLimit = 1;
    await rowAt(page, 'left', 'Pack').click();
    await page.getByTestId('files-copy').click();
    const card = page.getByTestId('transfers-card').first();
    await expect(card.getByTestId('transfers-card-line')).toContainText('1 of 3 files', { timeout: LIVE });

    await card.getByTestId('transfers-cancel').click();
    await expect(page.getByTestId('transfers-cancel-text')).toHaveText('Cancel the rest of this copy? What has arrived stays.');
    await page.getByTestId('transfers-cancel-yes').click();
    await expect(page.getByTestId('transfers-cancel-dialog')).toBeHidden({ timeout: LIVE });
    await expect(card.getByTestId('transfers-card-result')).toHaveText('Cancelled: 1 of 3 copied', { timeout: LIVE });
    await expect(card).toHaveAttribute('data-state', 'kept');

    // Nothing more goes, even with the board free to take it.
    fakeBoardTiming.queueLimit = Infinity;
    expect(await boardQueue(request, token)).toMatch(/^NEXT -/);
    expect((fs['Work:Tools/Pack'] ?? []).filter((e) => !e.dir)).toHaveLength(1);
    // A cancelled card stays until closed.
    await card.getByTestId('transfers-close').click();
    await expect(page.getByTestId('transfers-card')).toHaveCount(0);
  } finally { fakeBoardTiming.queueLimit = Infinity; await board.stop(); }
});
```

- [ ] **Step 7: Run the panel e2e spec**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/transfers-panel.spec.ts --reporter=line`
Expected: PASS (all three tests).

- [ ] **Step 8: Re-run the NET: writes spec (the fake board changed)**

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files-net-writes.spec.ts --reporter=line` (split with `-g` as in Task 6 if it nears 9 minutes)
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git status
git add e2e/amiga-board.ts e2e/transfers-panel.spec.ts src/lib/help/topics.tsx src/lib/help/topics.test.ts
git commit -m "Progress panel: Cancel the rest end to end against the fake board; the Files help says where progress shows"
```

---

**After the branch is merged (operator / controller, not a task):** the A500 bench of spec §7 — the Monkey Island case (four disks' files copied to Work:) watched in the panel from the Files page and from Library, then Cancel halfway; check that the files already on Work: stay and nothing more arrives. Record the result in HANDOFF.md §4.

## Rulings (spec silences decided while planning)

- **Cancelled parts carry the words `cancelled`** (as a Queue Delete's row already does) and are counted apart from failures; any job with a cancelled part, a failure, a kept drawer or a refused removal stays until closed (only a clean finish fades).
- **The cancel is recorded as a `remote_requests` row of kind `cancel`** (status `done`, never sent): no migration, and it carries whether the job was a move and where the rest still is. Every existing query filters by kind or status, so the row is inert elsewhere.
- **A cancelled move's markers are all cleared**, so a source whose files had all arrived but whose removal had not started is kept too (the spec's "safe side"); a removal already claimed before the cancel goes ahead. "N of M moved" counts the files that arrived.
- **Gets the board has taken but not opened are withdrawn too** (status `sent`): Transfer's open is refused (`name`), so nothing of them arrives.
- **A get's size is written at the start of a copy** (`target.size`, jsonb) so a copy off a volume has its total bytes before each upload opens; older rows fall back to the upload's size.
- **Between volumes each file's bytes count once**: half for the way up, half for the way down (the bar never goes back when a file is handed to the destination's queue).
- **The card counts files ended** ("0 of 2 files" while the first moves), not the 1-based "Copying 1 of 2"; its bar shows only while running; a finished card shows the result words; the failure list holds files (write failures are in the result line).
- **Plain Queue sends**: one synthetic job per board, id `queue:<board>:<newest row ms>` (a later batch is a new card); it holds the board's job-less rows that wait or move plus those finished since the oldest of them was queued, or, once none waits, those finished in the last 2 minutes. Finished words: "Sent N files to <board>".
- **Polling at 15 s only when every running job waits on an offline board**; one online job keeps 2 s. A failed ask is retried after 15 s.
- **Cards closed or faded are remembered per browser** (localStorage, last 50), so a reload does not bring back a card already seen; only a job this page saw running is announced.
- **Close (×) only on finished cards**; a running card has Cancel only. The panel opens expanded by default; the choice is remembered.
- **Placement**: lifted above `data-transfers-anchor` elements (the Files bank from lg, the Files bar below it); toasts sit above the panel (`--transfers-top`); the panel is `z-30`, under dialogs (`z-50`).
- **Words the spec did not give**: writes confirm "Cancel the rest of these changes? What is done stays."; "less than a minute left" under 45 s, else "about N min left"; KB under 1 MB, MB with one decimal; between boards "Copying from <src> to <dest> · <place>"; several writes "Deleting 3 items on <board>", mixed "Changing N items on <board>"; pill with nothing running "N finished".
- **Signed out**: the store stops asking and the panel says "Signed out — sign in again" while it shows cards.
- **`GET /api/files/net/fetch/<id>` stays** (Files no longer calls it; removing it is not in the spec).
- **Help goes into the `files` topic only**: `send` is at its 280-word cap.
- **Files' own notes** (a drawer that could not be read before a copy) keep the status row; only the NET: job line goes.
