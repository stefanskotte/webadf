# About Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the device card's "Custom server" line and add an `/about` page (opened from an (i) in the header) that shows the web app's build, hosted vs self-hosted, the platform, the org's newest installable firmware, and the org's library storage.

**Architecture:** Build facts (commit, build time, Next.js version) are fixed at build time in `next.config.ts` via `env`. Runtime facts come from small pure helpers in `src/lib/about/` plus one SQL round trip for library usage and the existing firmware registry for the firmware line. The page is one server component; each section's loader is settled separately so one failure shows "unavailable" without breaking the rest.

**Tech Stack:** Next.js (App Router, this repo's version -- read `node_modules/next/dist/docs/` before touching config), Drizzle on neon-http, vitest, Playwright, lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-15-about-page-design.md`

## Global Constraints

- `SELFHOSTED=false` (exact, lowercase) means our deployment ("Hosted"); every other value or none means "Self-hosted" (spec D2). Only `hostingMode()` reads `SELFHOSTED`.
- `/about` is for every signed-in user, scoped to their own org via `requireOrg()` (spec D3).
- The (i) is a link between the search box and Sign out, on every screen size, `aria-label="About this server"` (spec D4).
- The page never shows a connection string, host, token, URL of a store, or env value other than the ones listed (spec D5).
- No new tables, no migration (spec D6). No firmware change.
- Every section works self-hosted; no Vercel-only variable without a fallback (spec D7).
- Commit chain: `VERCEL_GIT_COMMIT_SHA` → `GIT_SHA` → `git rev-parse HEAD` → `unknown`.
- e2e runs on `PORT=3100`, one spec file per run, foreground, never in parallel with another e2e run (shared database).
- Help topic bodies are 60-260 words with no internal words (`src/lib/help/topics.test.ts`); every topic must be in `HELP_ORDER`.

## Review Focus

1. **A `SELFHOSTED` value with different case or spaces (`False`, ` false`)** -- reads Self-hosted. Pinned in Task 2's test table.
2. **A build with no `.git` and no env commit (Docker `COPY` without `.git`)** -- `git rev-parse` throws; the page must say `unknown`, not crash the build. Pinned in Task 2 (`git` returning null and throwing).
3. **A disk that shares its blob with a history snapshot, or two disks with the same bytes** -- counted once in bytes. Pinned in Task 4's e2e (two blank disks of identical content → bytes equal one image).
4. **One loader failing (DB hiccup on the firmware query)** -- that section says "unavailable", the rest renders. Pinned by Task 3's `settle` unit test.
5. **A fresh org (no disks, no boards)** -- zeros and "No boards paired", never NaN or an empty card. Pinned in Task 4's e2e.

---

### Task 1: Remove the card's server line

**Files:**
- Modify: `src/components/devices/device-card.tsx` (the `{device.serverCustom === true && (...)}` block, ~lines 249-256)
- Modify: `src/lib/help/topics.tsx` (the `own-server` topic's "On the card." paragraph, ~lines 421-425)
- Modify: `e2e/devices-page.spec.ts` (test "a board on a custom server says so…", ~lines 481-499)

**Interfaces:** none produced. `device.serverCustom` / `device.serverTls` stay in the row type; nothing else reads them in the UI after this.

- [ ] **Step 1: Change the e2e test to the new behaviour (it will fail first)**

Replace the whole test with:

```ts
test('a board on a custom server shows no server line on its card (the About page says how this server is hosted)', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const res = await request.post('/api/device/status', {
    headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: '1.13.0+gabc1234', server: { custom: true, tls: 'noverify' } },
  });
  expect(res.status()).toBe(204);
  await page.goto('/devices');
  await expect(page.getByTestId(`device-firmware-${deviceId}`)).toContainText('1.13.0', { timeout: LIVE });
  await expect(page.getByTestId(`device-server-${deviceId}`)).toHaveCount(0);
  await expect(page.getByText(/Custom server|certificate not checked/)).toHaveCount(0);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `PORT=3100 pnpm exec playwright test e2e/devices-page.spec.ts -g "no server line" --reporter=line`
Expected: FAIL (`device-server-…` count is 1).

- [ ] **Step 3: Delete the card block**

In `device-card.tsx` delete exactly this block (and the blank line after it):

```tsx
        {device.serverCustom === true && (
          <span className="block min-w-0 text-[11px]"
                style={{ overflowWrap: 'anywhere',
                         color: device.serverTls === 'noverify' ? 'var(--amber-text)' : 'var(--muted)' }}
                data-testid={`device-server-${device.id}`}>
            {device.serverTls === 'noverify' ? 'Custom server · certificate not checked' : 'Custom server'}
          </span>
        )}
```

- [ ] **Step 4: Rewrite the help paragraph**

In `topics.tsx`, replace the `<p><strong>On the card.</strong> …</p>` paragraph of `own-server` with:

```tsx
        <p>
          <strong>Updates.</strong> Firmware updates are still checked against our signing key, so a board on your own
          server only installs builds we signed. The full steps are in wifi-floppy/README.md.
        </p>
```

Also change the topic's source comment line `// … card line in devices/page.tsx (fw 1.13.0+);` to drop "card line in devices/page.tsx (fw 1.13.0+);".

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/lib/help` → PASS (word count still 60-260).
Run: `PORT=3100 pnpm exec playwright test e2e/devices-page.spec.ts --reporter=line` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/devices/device-card.tsx src/lib/help/topics.tsx e2e/devices-page.spec.ts
git commit -m "Devices: drop the card's Custom server line (operator ruling 2026-10-15; the About page will say how the server is hosted)"
```

---

### Task 2: Build info and hosting mode

**Files:**
- Create: `src/lib/about/build-info.ts`, `src/lib/about/build-info.test.ts`
- Create: `src/lib/about/hosting.ts`, `src/lib/about/hosting.test.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces:
  - `resolveCommit(env: Record<string, string | undefined>, git: () => string | null): string` -- pure; the first non-empty trimmed value of `VERCEL_GIT_COMMIT_SHA`, `GIT_SHA`, `git()` (a throw counts as empty), else `'unknown'`.
  - `shortCommit(commit: string): string`, `commitUrl(commit: string): string | null` -- 7 characters and a GitHub link only for a 40-hex sha.
  - `buildInfo(): { commit: string; shortCommit: string; commitUrl: string | null; builtAt: string | null; nextVersion: string }`
  - `hostingMode(raw?: string): 'hosted' | 'self-hosted'` (default arg `process.env.SELFHOSTED`)
  - `HOSTED_LABEL = 'Hosted (webadf.vercel.app)'`, `SELF_HOSTED_LABEL = 'Self-hosted'`

- [ ] **Step 1: Write the failing tests**

`src/lib/about/hosting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hostingMode } from './hosting';

describe('hostingMode', () => {
  it.each([
    ['false', 'hosted'],
    [undefined, 'self-hosted'],
    ['', 'self-hosted'],
    ['true', 'self-hosted'],
    ['False', 'self-hosted'],
    ['FALSE', 'self-hosted'],
    [' false', 'self-hosted'],
    ['0', 'self-hosted'],
  ] as const)('SELFHOSTED=%j -> %s', (raw, want) => {
    expect(hostingMode(raw)).toBe(want);
  });
});
```

`src/lib/about/build-info.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveCommit, shortCommit, commitUrl } from './build-info';

const SHA = 'c6e4639aabbccddeeff00112233445566778899a';

describe('resolveCommit', () => {
  it('prefers Vercel', () => {
    expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: SHA, GIT_SHA: 'other' }, () => 'git')).toBe(SHA);
  });
  it('falls back to GIT_SHA (a Docker build argument)', () => {
    expect(resolveCommit({ GIT_SHA: ` ${SHA}\n` }, () => 'git')).toBe(SHA);
  });
  it('falls back to git', () => {
    expect(resolveCommit({}, () => `${SHA}\n`)).toBe(SHA);
  });
  it('says unknown when git is missing or throws', () => {
    expect(resolveCommit({}, () => null)).toBe('unknown');
    expect(resolveCommit({ GIT_SHA: '' }, () => { throw new Error('no .git'); })).toBe('unknown');
  });
});

describe('shortCommit / commitUrl', () => {
  it('shortens a full sha and links it', () => {
    expect(shortCommit(SHA)).toBe('c6e4639');
    expect(commitUrl(SHA)).toBe(`https://github.com/stefanskotte/webadf/commit/${SHA}`);
  });
  it('never links something that is not a full sha', () => {
    expect(shortCommit('unknown')).toBe('unknown');
    expect(commitUrl('unknown')).toBeNull();
    expect(commitUrl('c6e4639')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run src/lib/about` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/lib/about/hosting.ts`:

```ts
/**
 * Hosted or self-hosted (About page spec D2). Self-hosted is the default:
 * only our deployment sets SELFHOSTED=false (Vercel project env), so a
 * self-hoster sets nothing. Exact, lowercase match -- anything else,
 * including "False", reads self-hosted. The only reader of SELFHOSTED.
 */
export type HostingMode = 'hosted' | 'self-hosted';

export const HOSTED_LABEL = 'Hosted (webadf.vercel.app)';
export const SELF_HOSTED_LABEL = 'Self-hosted';

export function hostingMode(raw: string | undefined = process.env.SELFHOSTED): HostingMode {
  return raw === 'false' ? 'hosted' : 'self-hosted';
}
```

`src/lib/about/build-info.ts`:

```ts
/**
 * What this server was built from (About page spec, "Web app"). The values
 * are fixed at BUILD time by next.config.ts (`env`), so a running server
 * reports its own build, not whatever checkout sits next to it.
 * resolveCommit has no imports so next.config.ts can call it.
 */
export function resolveCommit(env: Record<string, string | undefined>, git: () => string | null): string {
  for (const v of [env.VERCEL_GIT_COMMIT_SHA, env.GIT_SHA]) {
    const t = v?.trim();
    if (t) return t;
  }
  try {
    const t = git()?.trim();
    if (t) return t;
  } catch {
    // no .git (a Docker build that copied the sources only)
  }
  return 'unknown';
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export function shortCommit(commit: string): string {
  return FULL_SHA.test(commit) ? commit.slice(0, 7) : commit;
}

export function commitUrl(commit: string): string | null {
  return FULL_SHA.test(commit) ? `https://github.com/stefanskotte/webadf/commit/${commit}` : null;
}

export interface BuildInfo {
  commit: string;
  shortCommit: string;
  commitUrl: string | null;
  /** ISO 8601, or null when the build did not record one. */
  builtAt: string | null;
  nextVersion: string;
}

export function buildInfo(): BuildInfo {
  const commit = process.env.WEBADF_COMMIT || 'unknown';
  return {
    commit,
    shortCommit: shortCommit(commit),
    commitUrl: commitUrl(commit),
    builtAt: process.env.WEBADF_BUILT_AT || null,
    nextVersion: process.env.WEBADF_NEXT_VERSION || 'unknown',
  };
}
```

`next.config.ts` -- add at the top and an `env` key (keep `outputFileTracingIncludes` as is). Check `node_modules/next/dist/docs/` for the `env` option first (`grep -rl "^title: env" node_modules/next/dist/docs`) and follow it if it differs:

```ts
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { resolveCommit } from "./src/lib/about/build-info";

// The About page's build facts, fixed now so the running server reports its
// own build (spec 2026-10-15-about-page D7: no Vercel-only source without a
// fallback -- a Docker build passes GIT_SHA).
const WEBADF_COMMIT = resolveCommit(process.env, () =>
  execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString());
const WEBADF_NEXT_VERSION = (JSON.parse(readFileSync(require.resolve("next/package.json"), "utf8")) as { version: string }).version;
```

and inside `nextConfig`:

```ts
  env: {
    WEBADF_COMMIT,
    WEBADF_BUILT_AT: new Date().toISOString(),
    WEBADF_NEXT_VERSION,
  },
```

If `require` is not defined in this config's module format, use `createRequire(import.meta.url)` from `node:module` instead.

- [ ] **Step 4: Run tests and a build-free check**

Run: `pnpm vitest run src/lib/about` → PASS.
Run: `pnpm exec tsc --noEmit -p .` → no new errors.
Run: `pnpm next typegen` (or start `PORT=3100 pnpm dev` briefly) and confirm the config loads without error.

- [ ] **Step 5: Commit**

```bash
git add src/lib/about/build-info.ts src/lib/about/build-info.test.ts src/lib/about/hosting.ts src/lib/about/hosting.test.ts next.config.ts
git commit -m "About: build info fixed at build time (commit chain Vercel -> GIT_SHA -> git -> unknown) and the SELFHOSTED=false hosting rule"
```

---

### Task 3: Library usage, firmware summary, section settling

**Files:**
- Create: `src/lib/about/library-usage.ts`
- Create: `src/lib/about/firmware-summary.ts`
- Create: `src/lib/about/settle.ts`, `src/lib/about/settle.test.ts`
- Create: `src/lib/about/format-bytes.ts`, `src/lib/about/format-bytes.test.ts`
- Modify: `src/lib/storage.ts` (export one constant)

**Interfaces:**
- Consumes: `listReleases(orgId)` from `@/lib/firmware-releases`; `buildRegistry`, `firmwareState`, `countBehind`, `ReleaseRef` from `@/lib/firmware-state`; `listDevices(orgId)` from `@/lib/queries`.
- Produces:
  - `libraryUsage(orgId: string): Promise<{ titles: number; disks: number; versions: number; bytes: number }>`
  - `firmwareSummary(orgId: string): Promise<{ latest: ReleaseRef | null; boards: number; behind: number }>`
  - `settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>`
  - `formatBytes(n: number): string`
  - `STORAGE_BACKEND = 'Vercel Blob'` exported from `@/lib/storage`

- [ ] **Step 1: Write the failing tests**

`src/lib/about/settle.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { settle } from './settle';

describe('settle', () => {
  it('passes a value through', async () => {
    expect(await settle(Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  });
  it('turns a rejection into ok:false and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await settle(Promise.reject(new Error('db down')))).toEqual({ ok: false });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
```

`src/lib/about/format-bytes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'], [512, '512 B'], [901_120, '880 KB'], [1_802_240, '1.7 MB'],
    [52_428_800, '50 MB'], [3_221_225_472, '3.0 GB'],
  ])('%d -> %s', (n, want) => expect(formatBytes(n)).toBe(want));
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run src/lib/about` → FAIL on the two new files.

- [ ] **Step 3: Implement**

`src/lib/about/settle.ts`:

```ts
/** One About section's loader, so a failure blanks only that section (spec "Errors"). */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    console.error('about: section failed', e);
    return { ok: false };
  }
}
```

`src/lib/about/format-bytes.ts` (binary units, the way the browse page counts disk space):

```ts
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
```

`src/lib/about/library-usage.ts`:

```ts
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

export interface LibraryUsage { titles: number; disks: number; versions: number; bytes: number }

/**
 * This org's library in one round trip (About page spec, "Your library").
 * bytes = the DISTINCT blobs the org's current disks and history versions
 * point at, joined to `blobs` for their size: a blob two disks share counts
 * once; a blob another org also holds counts in full here too (it is ours as
 * well). History DELTA blobs are not rows in `blobs` (disk-history/store.ts
 * inserts only snapshots), so they drop out of the join -- they are a few KB
 * each. Casts: count(*) and sum() come back as strings from neon-http
 * without them (see admin-queries.ts adminCounts).
 */
export async function libraryUsage(orgId: string): Promise<LibraryUsage> {
  const { rows } = await getDb().execute<{ titles: number; disks: number; versions: number; bytes: string }>(sql`
    select
      (select count(*)::int from games where org_id = ${orgId})          as titles,
      (select count(*)::int from disks where org_id = ${orgId})          as disks,
      (select count(*)::int from disk_versions where org_id = ${orgId})  as versions,
      (select coalesce(sum(b.size_bytes), 0)::bigint from blobs b
        where b.sha256 in (
          select sha256 from disks where org_id = ${orgId}
          union
          select blob_sha256 from disk_versions where org_id = ${orgId}
        ))                                                                as bytes
  `);
  const r = rows[0];
  return { titles: Number(r.titles), disks: Number(r.disks), versions: Number(r.versions), bytes: Number(r.bytes) };
}
```

`src/lib/about/firmware-summary.ts`:

```ts
import { listReleases } from '@/lib/firmware-releases';
import { listDevices } from '@/lib/queries';
import { buildRegistry, firmwareState, countBehind, type ReleaseRef } from '@/lib/firmware-state';

/**
 * The newest release this org may install and how many of its boards are
 * behind it -- the SAME registry the Devices page builds, so the two pages
 * cannot disagree (TEST builds only for FIRMWARE_BENCH_ORGS, via listReleases).
 */
export async function firmwareSummary(orgId: string): Promise<{ latest: ReleaseRef | null; boards: number; behind: number }> {
  const [releases, devices] = await Promise.all([listReleases(orgId), listDevices(orgId)]);
  const registry = buildRegistry(releases);
  const states = devices.map((d) => firmwareState(d.firmwareVersion, registry));
  return { latest: registry.latest, boards: devices.length, behind: countBehind(states) };
}
```

(If `registry.latest` is typed `ReleaseRef | undefined`, return `registry.latest ?? null`.)

`src/lib/storage.ts` -- add near the top, after the imports:

```ts
/** What the About page names as file storage (spec D5: the kind, never the store's URL or token). */
export const STORAGE_BACKEND = 'Vercel Blob';
```

- [ ] **Step 4: Run tests and types**

Run: `pnpm vitest run src/lib/about` → PASS. Run: `pnpm exec tsc --noEmit -p .` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/about src/lib/storage.ts
git commit -m "About: library usage in one query, firmware summary from the Devices registry, per-section settle, byte formatting"
```

---

### Task 4: The page, the (i), help and README

**Files:**
- Create: `src/app/(app)/about/page.tsx`
- Create: `src/components/shell/about-link.tsx`
- Modify: `src/app/(app)/layout.tsx` (the `<SearchBox /> <SignOutButton />` row, ~line 137)
- Modify: `src/lib/help/topics.tsx` (new `about` topic; add to `HELP_ORDER`)
- Modify: `README.md` ("Running it")
- Create: `e2e/about-page.spec.ts`

**Interfaces:**
- Consumes everything Task 2 and Task 3 produce; `requireOrg()` from `@/lib/session`; `PageHeader` from `@/components/shell/page-header`; `Link` from `@/components/shell/link`; `createAdf`, `signUpFresh` from `e2e/helpers`.

- [ ] **Step 1: Write the failing e2e spec**

`e2e/about-page.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh, createAdf } from './helpers';

test('the (i) opens About: build, hosting, platform, firmware and an empty library', async ({ page }) => {
  await signUpFresh(page);
  await page.getByRole('link', { name: 'About this server' }).click();
  await expect(page).toHaveURL(/\/about$/);
  for (const id of ['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']) {
    await expect(page.getByTestId(`about-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('about-commit')).not.toHaveText('');
  await expect(page.getByTestId('about-hosting-mode')).toHaveText(/^(Hosted \(webadf\.vercel\.app\)|Self-hosted)$/);
  await expect(page.getByTestId('about-firmware')).toContainText('No boards paired');
  await expect(page.getByTestId('about-library-disks')).toHaveText('0');
  await expect(page.getByTestId('about-library-bytes')).toHaveText('0 B');
  const text = await page.locator('main, body').first().innerText();
  for (const secret of ['postgres://', 'postgresql://', 'vercel_blob_rw_', 'BETTER_AUTH', 'DATABASE_URL']) {
    expect(text).not.toContain(secret);
  }
});

test('two identical blank disks count as one image of stored bytes', async ({ page }) => {
  await signUpFresh(page);
  await createAdf(page, 'FFS');
  await page.goto('/library');
  await createAdf(page, 'FFS');
  await page.goto('/about');
  await expect(page.getByTestId('about-library-disks')).toHaveText('2');
  // A blank 880 KB FFS image; the second disk has the same bytes only if the
  // volume name and date match -- so assert "at most two images" and "at least one".
  const exact = Number(await page.getByTestId('about-library-bytes').getAttribute('data-bytes'));
  expect(exact).toBeGreaterThanOrEqual(901_120);
  expect(exact).toBeLessThanOrEqual(2 * 901_120);
});
```

Before relying on it, read `createAdf` in `e2e/helpers.ts` to confirm where it leaves the page; if two blank disks never share bytes (each has its own creation date), the second test still pins "bytes is a sum over images, not 0 or NaN".

- [ ] **Step 2: Run it and see it fail**

Run: `PORT=3100 pnpm exec playwright test e2e/about-page.spec.ts --reporter=line` → FAIL (no "About this server" link).

- [ ] **Step 3: The (i) link**

`src/components/shell/about-link.tsx`:

```tsx
import { InfoIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';

/** The header's (i): what this server is (About page spec D4). Same colours as Sign out. */
export function AboutLink() {
  return (
    <Link href="/about" aria-label="About this server" title="About this server"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[color:var(--on-dark-muted)] hover:bg-white/10 hover:text-[color:var(--on-dark)]">
      <InfoIcon className="size-[18px]" aria-hidden />
    </Link>
  );
}
```

In `src/app/(app)/layout.tsx`, import it and change the row to:

```tsx
            <SearchBox />
            <AboutLink />
            <SignOutButton />
```

- [ ] **Step 4: The page**

`src/app/(app)/about/page.tsx`:

```tsx
import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { Link } from '@/components/shell/link';
import { buildInfo } from '@/lib/about/build-info';
import { hostingMode, HOSTED_LABEL, SELF_HOSTED_LABEL } from '@/lib/about/hosting';
import { libraryUsage } from '@/lib/about/library-usage';
import { firmwareSummary } from '@/lib/about/firmware-summary';
import { settle } from '@/lib/about/settle';
import { formatBytes } from '@/lib/about/format-bytes';
import { STORAGE_BACKEND } from '@/lib/storage';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="glass-card p-5" data-testid={`about-${id}`}>
      <h2 className="mb-2 text-[13px] font-semibold">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><dt style={{ color: 'var(--muted)' }}>{label}</dt><dd className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{children}</dd></>);
}

const UNAVAILABLE = <span style={{ color: 'var(--muted)' }}>unavailable</span>;

export default async function AboutPage() {
  const { orgId } = await requireOrg();
  const [usage, firmware] = await Promise.all([settle(libraryUsage(orgId)), settle(firmwareSummary(orgId))]);
  const build = buildInfo();
  const hosted = hostingMode() === 'hosted';

  return (
    <>
      <PageHeader eyebrow="Server" title="About" help="about" />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        <Section id="web-app" title="Web app">
          <Row label="Commit">
            <span data-testid="about-commit">
              {build.commitUrl ? <a href={build.commitUrl} className="underline">{build.shortCommit}</a> : build.shortCommit}
            </span>
          </Row>
          <Row label="Built">{build.builtAt ? <time dateTime={build.builtAt}>{new Date(build.builtAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</time> : 'unknown'}</Row>
        </Section>

        <Section id="hosting" title="Hosting">
          <Row label="This server"><span data-testid="about-hosting-mode">{hosted ? HOSTED_LABEL : SELF_HOSTED_LABEL}</span></Row>
        </Section>

        <Section id="platform" title="Platform">
          <Row label="Runtime">Node.js {process.versions.node}</Row>
          <Row label="Framework">Next.js {build.nextVersion}</Row>
          <Row label="Database">PostgreSQL</Row>
          <Row label="File storage">{STORAGE_BACKEND}</Row>
        </Section>

        <Section id="firmware" title="Board firmware">
          {firmware.ok ? (
            <>
              <Row label="Newest">{firmware.value.latest ? `${firmware.value.latest.version} (sequence ${firmware.value.latest.sequence})` : 'none published'}</Row>
              <Row label="Your boards">{firmware.value.boards === 0 ? 'No boards paired' : `${firmware.value.behind} of ${firmware.value.boards} behind`}</Row>
            </>
          ) : <Row label="Firmware">{UNAVAILABLE}</Row>}
        </Section>

        <Section id="library" title="Your library">
          {usage.ok ? (
            <>
              <Row label="Titles"><span data-testid="about-library-titles">{usage.value.titles}</span></Row>
              <Row label="Disks"><span data-testid="about-library-disks">{usage.value.disks}</span></Row>
              <Row label="History versions"><span data-testid="about-library-versions">{usage.value.versions}</span></Row>
              <Row label="Stored">
                <span data-testid="about-library-bytes" data-bytes={usage.value.bytes} title={`${usage.value.bytes.toLocaleString('en-GB')} bytes`}>
                  {formatBytes(usage.value.bytes)}
                </span>
              </Row>
            </>
          ) : <Row label="Library">{UNAVAILABLE}</Row>}
        </Section>

        <Section id="about-webadf" title="webadf">
          <Row label="What">An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.</Row>
          <Row label="Licence">MIT</Row>
          <Row label="More"><Link href="/help" className="underline">Help</Link> · <a href="https://github.com/stefanskotte/webadf" className="underline">Repository</a></Row>
        </Section>
      </div>
    </>
  );
}
```

Note the firmware test id: the e2e expects `about-firmware` to contain "No boards paired" -- the Section's own `data-testid="about-firmware"` covers that. Check `/help` is the help index route (`ls "src/app/(app)/help"`); use its real path.

- [ ] **Step 5: Help topic**

Add to `HELP_TOPICS` in `topics.tsx` (before the closing `} as const`), and append `'about'` to `HELP_ORDER`:

```tsx
  // Sources: spec 2026-10-15-about-page-design.md; src/lib/about/*; src/app/(app)/about/page.tsx.
  about: {
    title: 'About this server',
    short: 'What this copy of the site is: its build, where it runs, and how much your library stores.',
    body: (
      <>
        <p>
          <strong>Web app.</strong> The commit the site was built from, and when. On our own site the commit links to
          the change that produced it.
        </p>
        <p>
          <strong>Hosting.</strong> <em>Hosted</em> is this site, run by us. Anything else says <em>Self-hosted</em>:
          a copy someone runs on their own server. Nothing has to be set for that; every copy except ours reads
          self-hosted.
        </p>
        <p>
          <strong>Board firmware.</strong> The newest firmware your boards can install, and how many of your boards
          are behind it. The Devices page has the Update button.
        </p>
        <p>
          <strong>Your library.</strong> Your titles, disks and saved versions, and the space their disk images take.
          A disk image you hold twice is counted once. Other people&apos;s libraries are never included.
        </p>
      </>
    ),
  },
```

- [ ] **Step 6: README**

In `README.md` "Running it", after the `pnpm dev` block, add:

```markdown
A self-hosted copy needs no extra setting: the About page (the (i) at the top right) reads
**Self-hosted** unless `SELFHOSTED=false`, which only our own deployment sets. A Docker build
without `.git` can pass `GIT_SHA` so the About page shows the commit.
```

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run` → all PASS (help topic word count, HELP_ORDER completeness).
Run: `pnpm exec tsc --noEmit -p .` and `pnpm lint` → clean.
Run: `PORT=3100 pnpm exec playwright test e2e/about-page.spec.ts --reporter=line` → PASS.
Run: `PORT=3100 pnpm exec playwright test e2e/help.spec.ts --reporter=line` → PASS (the help index lists the new topic).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/about/page.tsx" src/components/shell/about-link.tsx "src/app/(app)/layout.tsx" src/lib/help/topics.tsx README.md e2e/about-page.spec.ts
git commit -m "About page: build, hosting, platform, firmware and library storage, opened from the header's (i)"
```

---

### Task 5: Rollout (operator-gated)

- [ ] **Step 1:** Ask the operator before setting `SELFHOSTED=false` in the Vercel project (Production and Preview). On a yes, set it (`vercel env add SELFHOSTED production` / `preview`, value `false`), and confirm with `vercel env ls`.
- [ ] **Step 2:** Whole-branch review; fix wave; re-run the touched e2e specs (`about-page`, `devices-page`, `help`).
- [ ] **Step 3:** Merge `--no-ff` to master, push, and after the deploy open `https://webadf.vercel.app/about`: it must say **Hosted (webadf.vercel.app)** and show the deployed commit.
- [ ] **Step 4:** HANDOFF: a new section for the About page; mark 3bn's card-line follow-up as done.
