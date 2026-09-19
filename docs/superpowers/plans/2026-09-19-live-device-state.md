# Live device state — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every open browser shows the org's current device and mounted-disk state within ~3 s,
without a reload.

**Architecture:** A pure fingerprint of the org's device state (`src/lib/live-state.ts`), served by
`GET /api/live-state`. A client component in the app layout polls it every 3 s while the tab is
visible and calls `router.refresh()` when it changes.

**Tech Stack:** Next.js App Router (server components + one client component), drizzle over Neon,
vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-19-live-device-state-design.md`

## Global Constraints

- Poll interval **3000 ms**; only while `document.visibilityState === 'visible'`; fetch at once on
  becoming visible.
- Fingerprint = first **16** hex of sha-256 over the canonical per-device strings, devices ordered
  by id; `lastSeenAt` itself never included, only `deviceState(row, now)` from
  `src/lib/device-state.ts`.
- `GET /api/live-state` → `200 {"fingerprint": "<16 hex>"}`, `Cache-Control: no-store`, scoped by
  `requireOrg()`.
- No refresh while `document.activeElement` is an `input`, a `textarea` or contenteditable; the
  refresh is deferred until focus leaves.
- e2e runs against the LIVE production database. Accounts must be `@example.test` (use
  `signUpFresh`), and seeded disks must go through `seedDisk` + `cleanupSeeded`.
- vitest: `pnpm vitest run`; e2e: `pnpm exec playwright test <file>` in the FOREGROUND.
- Never `git add -A`; stage explicit paths. No `git stash`.

---

### Task 1: The fingerprint

**Files:**
- Create: `src/lib/live-state.ts`
- Test: `src/lib/live-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LiveStateRow {
    id: string; name: string;
    desiredDiskId: string | null; desiredSha256: string | null; desiredVersion: number;
    mountedSha256: string | null; mountedVersion: number | null; lastSeenAt: Date | null;
    diskSha256: string | null; diskWriteProtected: boolean | null;
  }
  export function liveFingerprint(rows: readonly LiveStateRow[], now: number): string;
  export async function liveStateRows(db: ReturnType<typeof getDb>, orgId: string): Promise<LiveStateRow[]>;
  ```

- [ ] **Step 1: Write the failing test** — `src/lib/live-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { liveFingerprint, type LiveStateRow } from './live-state';
import { STALE_AFTER_MS } from './device-state';

const NOW = 1_800_000_000_000;
const base: LiveStateRow = {
  id: 'dev-a', name: 'Bench',
  desiredDiskId: 'disk-1', desiredSha256: 'a'.repeat(64), desiredVersion: 4,
  mountedSha256: 'a'.repeat(64), mountedVersion: 4, lastSeenAt: new Date(NOW - 5_000),
  diskSha256: 'a'.repeat(64), diskWriteProtected: false,
};
const other: LiveStateRow = { ...base, id: 'dev-b', name: 'Second' };
const fp = (rows: LiveStateRow[], now = NOW) => liveFingerprint(rows, now);

describe('liveFingerprint', () => {
  it('is 16 hex characters and stable across row order', () => {
    expect(fp([base, other])).toMatch(/^[0-9a-f]{16}$/);
    expect(fp([base, other])).toBe(fp([other, base]));
  });

  it.each([
    ['desired disk', { desiredDiskId: 'disk-2' }],
    ['desired digest', { desiredSha256: 'b'.repeat(64) }],
    ['desired version', { desiredVersion: 5 }],
    ['mounted digest', { mountedSha256: 'c'.repeat(64) }],
    ['mounted version', { mountedVersion: 5 }],
    ['write-protect', { diskWriteProtected: true }],
    ['the disk digest (a board write)', { diskSha256: 'd'.repeat(64) }],
    ['the device name', { name: 'Renamed' }],
  ] as const)('changes when the %s changes', (_what, patch) => {
    expect(fp([{ ...base, ...patch }])).not.toBe(fp([base]));
  });

  it('changes when time alone moves a device past the stale threshold', () => {
    // Pending (desired != mounted) reads differently when the device goes quiet.
    const pending = { ...base, mountedSha256: null, mountedVersion: null };
    expect(fp([pending], NOW)).not.toBe(fp([pending], NOW + STALE_AFTER_MS + 1));
  });

  it('does not change when only lastSeenAt moves within the threshold', () => {
    expect(fp([{ ...base, lastSeenAt: new Date(NOW - 20_000) }]))
      .toBe(fp([{ ...base, lastSeenAt: new Date(NOW - 1_000) }]));
  });

  it('distinguishes no devices from one device', () => {
    expect(fp([])).not.toBe(fp([base]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/live-state.test.ts`
Expected: FAIL — cannot resolve `./live-state`.

- [ ] **Step 3: Implement** — `src/lib/live-state.ts`:

```ts
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { deviceState } from '@/lib/device-state';

/**
 * What every open browser watches to know when to re-render (spec
 * 2026-09-19-live-device-state-design.md). Covers exactly what the pages show
 * about devices and the disks they hold: a change here means some page would
 * render differently, and nothing else changes it.
 */
export interface LiveStateRow {
  id: string; name: string;
  desiredDiskId: string | null; desiredSha256: string | null; desiredVersion: number;
  mountedSha256: string | null; mountedVersion: number | null; lastSeenAt: Date | null;
  diskSha256: string | null; diskWriteProtected: boolean | null;
}

/**
 * First 16 hex of a sha-256 over one canonical line per device, ordered by id.
 * `lastSeenAt` is NOT in it -- it moves every poll -- only the state derived
 * from it, which is what the pages render and what changes with time alone.
 */
export function liveFingerprint(rows: readonly LiveStateRow[], now: number): string {
  const lines = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => [
      r.id, r.desiredDiskId ?? '', r.desiredSha256 ?? '', r.desiredVersion,
      r.mountedSha256 ?? '', r.mountedVersion ?? '', deviceState(r, now),
      r.diskSha256 ?? '', r.diskWriteProtected === null ? '' : String(r.diskWriteProtected), r.name,
    ].join('|'));
  return createHash('sha256').update(`${lines.length}\n${lines.join('\n')}`).digest('hex').slice(0, 16);
}

export async function liveStateRows(db: ReturnType<typeof getDb>, orgId: string): Promise<LiveStateRow[]> {
  return db
    .select({
      id: devices.id, name: devices.name,
      desiredDiskId: devices.desiredDiskId, desiredSha256: devices.desiredSha256,
      desiredVersion: devices.desiredVersion,
      mountedSha256: devices.mountedSha256, mountedVersion: devices.mountedVersion,
      lastSeenAt: devices.lastSeenAt,
      diskSha256: disks.sha256, diskWriteProtected: disks.writeProtected,
    })
    .from(devices)
    .leftJoin(disks, eq(disks.id, devices.desiredDiskId))
    .where(eq(devices.orgId, orgId))
    .orderBy(asc(devices.id));
}
```

Check the column names against `src/db/schema/devices.ts` and `src/db/schema/catalog.ts` and
adjust the `LiveStateRow` types to the real nullability (for example, if `desiredVersion` is
nullable there, make it `number | null` and render it with `?? ''`). The test's rows must stay
valid.

- [ ] **Step 4: Run the tests** — `pnpm vitest run src/lib/live-state.test.ts` passes; then
`pnpm vitest run` (all) passes, and `pnpm exec tsc --noEmit` is clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-state.ts src/lib/live-state.test.ts
git commit -m "live-state: a fingerprint of the org's device state that changes exactly when a page would

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The endpoint and the poller

**Files:**
- Create: `src/app/api/live-state/route.ts`
- Create: `src/components/shell/live-refresh.tsx`
- Modify: `src/app/(app)/layout.tsx` (render `<LiveRefresh />` once, inside `NavProgressProvider`)

**Interfaces:**
- Consumes: `liveStateRows`, `liveFingerprint` (Task 1); `requireOrg` (`src/lib/session.ts`);
  `getDb` (`src/db`).
- Produces: `GET /api/live-state` → `{ fingerprint: string }`; `<LiveRefresh />` (no props).

- [ ] **Step 1: The route** — `src/app/api/live-state/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { liveFingerprint, liveStateRows } from '@/lib/live-state';

export const dynamic = 'force-dynamic';

/**
 * The fingerprint every open browser polls (LiveRefresh). One query over the
 * org's devices. Never cached: a cached answer is the stale page this prevents.
 */
export async function GET() {
  const { orgId } = await requireOrg();
  const fingerprint = liveFingerprint(await liveStateRows(getDb(), orgId), Date.now());
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
```

- [ ] **Step 2: The poller** — `src/components/shell/live-refresh.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Spec decision L2. */
export const LIVE_POLL_MS = 3000;

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * Keeps this tab's device state current without a reload (spec
 * 2026-09-19-live-device-state-design.md). Renders nothing.
 */
export function LiveRefresh() {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const owed = useRef(false);        // a change seen while the user was typing
  const inFlight = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    async function check() {
      if (inFlight.current || document.visibilityState !== 'visible') return;
      inFlight.current = true;
      try {
        const res = await fetch('/api/live-state', { cache: 'no-store' });
        if (!res.ok) return;
        const { fingerprint } = (await res.json()) as { fingerprint?: string };
        if (typeof fingerprint !== 'string') return;
        if (last.current === null) { last.current = fingerprint; return; }
        if (fingerprint !== last.current) { last.current = fingerprint; owed.current = true; }
        if (owed.current && !typing()) { owed.current = false; router.refresh(); }
      } catch {
        // Offline, signed out, a deploy: say nothing, try again next tick.
      } finally {
        inFlight.current = false;
      }
    }

    function start() {
      if (timer === null) timer = setInterval(check, LIVE_POLL_MS);
    }
    function stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') { void check(); start(); } else stop();
    }

    void check();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [router]);

  return null;
}
```

- [ ] **Step 3: Mount it** in `src/app/(app)/layout.tsx`: import `LiveRefresh` from
`@/components/shell/live-refresh` and render `<LiveRefresh />` once, as the first child inside
`<NavProgressProvider>`. Nothing else in the layout changes.

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit` clean, `pnpm vitest run` green, `pnpm build`
clean. (Behaviour is proven by Task 3's e2e.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/live-state/route.ts src/components/shell/live-refresh.tsx "src/app/(app)/layout.tsx"
git commit -m "live-state: every page polls the fingerprint every 3 s while visible and re-renders on change

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Two browsers, one of them never touched

**Files:**
- Create: `e2e/live-state.spec.ts`

**Interfaces:**
- Consumes: `LIVE_POLL_MS` (Task 2); `signUpFresh`, `runTag` (`e2e/helpers.ts`); `pairDevice`,
  `seedDisk`, `authHeader`, `cleanupSeeded` (`e2e/device-helpers.ts`). The device card carries
  `data-testid="device-<id>"` and `data-state` (`empty|converged|pending|stale`); the write-protect
  toggle carries `data-testid="wp-<diskId>"` and `data-protected`.

- [ ] **Step 1: Write the tests** — `e2e/live-state.spec.ts`:

```ts
import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

// The 3 s interval plus a request and a re-render. Anything slower is a bug.
const LIVE = { timeout: 5_000 };

/** Browser A signs up; browser B signs in as the same user and never reloads. */
async function twoBrowsers(browser: Browser, pageA: Page) {
  const { email, password, orgId } = await signUpFresh(pageA);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/sign-in');
  await pageB.getByLabel('Email').fill(email);
  await pageB.getByLabel('Password').fill(password);
  await pageB.getByRole('button', { name: 'Sign in' }).click();
  await expect(pageB).toHaveURL(/\/library/, { timeout: 15_000 });
  return { orgId, pageB, closeB: () => ctxB.close() };
}

async function diskFor(orgId: string) {
  const sha = createHash('sha256').update(`live-${runTag()}-${Math.random()}`).digest('hex');
  const { gameId, diskId } = await seedDisk(orgId, { title: `Live ${runTag()}`, diskNo: 1, sha256: sha });
  return { gameId, diskId, sha };
}

test('a mount made in one browser, and the board converging, show in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    const { deviceId, token } = await pairDevice(page, request);
    const { diskId, sha } = await diskFor(orgId);
    await pageB.goto('/devices');
    const card = pageB.getByTestId(`device-${deviceId}`);
    await expect(card).toHaveAttribute('data-state', 'empty');

    const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
    expect(mounted.status()).toBe(200);
    const { version } = await mounted.json();
    await expect(card).toHaveAttribute('data-state', 'pending', LIVE);

    expect((await request.post('/api/device/status', {
      headers: authHeader(token), data: { mountedSha256: sha, mountedDiskId: diskId, version },
    })).status()).toBe(204);
    await expect(card).toHaveAttribute('data-state', 'converged', LIVE);
    await closeB();
  });

test('write-protect changed in one browser shows in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    const { deviceId } = await pairDevice(page, request);
    const { gameId, diskId } = await diskFor(orgId);
    // Watched only for a disk a device has asked for (spec §6).
    expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);
    await pageB.goto(`/games/${gameId}`);
    const toggle = pageB.getByTestId(`wp-${diskId}`);
    await expect(toggle).toHaveAttribute('data-protected', 'true');

    expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
    await expect(toggle).toHaveAttribute('data-protected', 'false', LIVE);
    await closeB();
  });

test('an idle page polls the fingerprint and never re-renders', async ({ page, request }) => {
  await signUpFresh(page);
  await pairDevice(page, request);
  await page.goto('/devices');
  let polls = 0, rsc = 0;
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/live-state')) polls++;
    if (url.includes('_rsc=') || r.headers()['rsc'] === '1') rsc++;
  });
  await page.waitForTimeout(10_000);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(rsc).toBe(0);
});
```

If a selector here does not match the page (the sign-in labels, the game route, the
`data-protected` initial value of a seeded disk), read the page and fix the test to match what
the page really renders. Never weaken an assertion to make it pass.

- [ ] **Step 2: Run against Task 2's code** —
`pnpm exec playwright test e2e/live-state.spec.ts --reporter=line` (foreground): 3 passed.
Then prove the tests are not vacuous: temporarily comment out `<LiveRefresh />` in the layout,
re-run, and confirm the first two FAIL on their `LIVE` assertions. Restore the line, re-run, and
see 3 passed again. Record both runs in the report.

- [ ] **Step 3: Commit**

```bash
git add e2e/live-state.spec.ts
git commit -m "e2e: a second browser follows mounts, the board and write-protect without a reload

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
