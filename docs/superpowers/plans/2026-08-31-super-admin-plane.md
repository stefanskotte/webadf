# Super-Admin Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator three pages — a database overview, a user list with a real cascade delete, and invite issue/revoke — behind an env-var allowlist that lives outside the database.

**Architecture:** A new `(admin)` route group mirroring `(app)`. Every page and every `/api/admin/*` route independently calls `requireSuperAdmin()`. All unscoped queries live in one module with a stated import boundary, because every other query in this codebase goes through `orgFilter()` and these deliberately do not.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Components) · React 19.2 · Tailwind 4 · shadcn v4 (**Base UI, not Radix**) · Drizzle 0.45 · better-auth 1.7.1 · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-08-31-super-admin-plane-design.md`

## Global Constraints

- **`src/lib/superadmin.ts` is the ONLY file that reads `SUPERADMIN_EMAILS`.** One answer to "who can cross the org boundary", in one auditable file.
- **`src/lib/admin-queries.ts` holds every unscoped query.** Nothing outside `src/app/(admin)` and `src/app/api/admin` may import it. Every other query in this codebase goes through `orgFilter()` (`src/db/scope.ts` — "the single chokepoint for tenant isolation"); these deliberately bypass it, and that is why they are quarantined.
- **Fail closed.** An unset or empty `SUPERADMIN_EMAILS` means nobody is an admin. Never default to allow.
- **Exact match only** on a lowercased, trimmed, comma-split allowlist. Never substring, never domain suffix.
- **Each `/api/admin/*` route calls `requireSuperAdmin()` itself.** The page guard is not the API guard; a page render and a later `fetch` are separate requests and only the second is what an attacker sends.
- **`blobs` is NEVER deleted.** It is content-addressed, has no `orgId`, and is shared across organizations. Deleting one tenant's last reference corrupts a different tenant's library.
- **A non-admin is redirected to `/library`, not 404'd** — the response must not confirm `/admin` exists.
- **Next 16:** `params`/`searchParams`/`cookies()`/`headers()` are Promises. `PageProps`/`RouteContext` are ambient — never import them. `cacheComponents` stays off.
- **shadcn v4 here is Base UI, not Radix.** Any Radix-era snippet is wrong.
- **Vitest never opens a database connection** — pure logic only. Pages and flows are Playwright.
- Every e2e spec calls `test.afterAll(cleanupSeeded)` from `e2e/device-helpers.ts` and runs against the operator's **live** database.
- Run `pnpm vitest run`, `pnpm e2e` and `pnpm build` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/superadmin.ts` | **Create.** `parseAllowlist()` (pure) + `requireSuperAdmin()`. The only reader of the env var. |
| `src/lib/superadmin.test.ts` | **Create.** Vitest. The security boundary. |
| `src/lib/admin-queries.ts` | **Create.** Unscoped queries: counts, user list, per-org library sizes, invite list. |
| `src/app/(admin)/layout.tsx` | **Create.** Admin shell; calls `requireSuperAdmin()`. |
| `src/app/(admin)/admin/page.tsx` | **Create.** Database overview. |
| `src/app/(admin)/admin/users/page.tsx` | **Create.** Paginated user list + delete. |
| `src/app/(admin)/admin/invites/page.tsx` | **Create.** Invite list + issue + revoke. |
| `src/components/admin/delete-user-dialog.tsx` | **Create.** Client. Names the blast radius; requires typing the email. |
| `src/components/admin/issue-invite-button.tsx` | **Create.** Client. |
| `src/components/admin/revoke-invite-button.tsx` | **Create.** Client. |
| `src/app/api/admin/invites/route.ts` | **Create.** `POST` issue. |
| `src/app/api/admin/invites/[code]/route.ts` | **Create.** `DELETE` revoke. |
| `src/app/api/admin/users/[id]/route.ts` | **Create.** `DELETE` cascade. |
| `src/lib/admin-delete.ts` | **Create.** The cascade, in one transaction. Its own file because it is the destructive one. |
| `src/proxy.ts` | **Modify.** Matcher gains `/admin/:path*`. |
| `e2e/admin-helpers.ts` | **Create.** `signInAsSuperAdmin(page)`. |
| `e2e/admin-guard.spec.ts`, `admin-invites.spec.ts`, `admin-delete.spec.ts` | **Create.** |
| `.env.local` | **Modify (local only).** `SUPERADMIN_EMAILS` for dev and e2e. |

---

### Task 1: `requireSuperAdmin` — the whole security boundary

**Files:**
- Create: `src/lib/superadmin.ts`, `src/lib/superadmin.test.ts`

**Interfaces:**
- Consumes: `auth` from `@/lib/auth`.
- Produces:

```ts
/** Pure. Exported for tests; nothing else should call it. */
export function parseAllowlist(raw: string | undefined): string[];
/** Pure. The whole decision. */
export function isAllowed(email: string | undefined, raw: string | undefined): boolean;
/** Mirrors requireOrg()'s shape deliberately -- but returns NO orgId. */
export function requireSuperAdmin(): Promise<{ userId: string; email: string }>;
```

- [ ] **Step 1: Write the failing tests**

`src/lib/superadmin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from './superadmin';

const LIST = 'sfs@enhance-it.dk, Second@Example.com ';

describe('parseAllowlist', () => {
  it('splits, trims and lowercases', () => {
    expect(parseAllowlist(LIST)).toEqual(['sfs@enhance-it.dk', 'second@example.com']);
  });
  it('is empty for undefined, empty and whitespace', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
  it('drops empty entries from stray commas', () => {
    expect(parseAllowlist('a@b.com,,')).toEqual(['a@b.com']);
  });
});

describe('isAllowed', () => {
  it('accepts an exact match regardless of case or padding', () => {
    expect(isAllowed('sfs@enhance-it.dk', LIST)).toBe(true);
    expect(isAllowed('  SFS@Enhance-It.DK  ', LIST)).toBe(true);
  });

  // Each of the following is a plausible refactor, which is why each is a test.

  it('DENIES everyone when the allowlist is unset or empty', () => {
    expect(isAllowed('sfs@enhance-it.dk', undefined)).toBe(false);
    expect(isAllowed('sfs@enhance-it.dk', '')).toBe(false);
    expect(isAllowed('sfs@enhance-it.dk', '   ')).toBe(false);
  });
  it('denies a suffix attack on the domain', () => {
    expect(isAllowed('sfs@enhance-it.dk.evil.com', LIST)).toBe(false);
  });
  it('denies a bare domain', () => {
    expect(isAllowed('@enhance-it.dk', LIST)).toBe(false);
  });
  it('denies a substring of an allowed address', () => {
    expect(isAllowed('s@enhance-it.dk', LIST)).toBe(false);
    expect(isAllowed('enhance-it.dk', LIST)).toBe(false);
  });
  it('denies a prefix attack', () => {
    expect(isAllowed('evilsfs@enhance-it.dk', LIST)).toBe(false);
  });
  it('denies an undefined or empty email', () => {
    expect(isAllowed(undefined, LIST)).toBe(false);
    expect(isAllowed('', LIST)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch every test fail**

```bash
pnpm vitest run src/lib/superadmin.test.ts
```

Expected: the file fails to resolve `./superadmin`. Create the module with the two pure functions declared but returning `[]`/`false`, re-run, and confirm the *positive* cases fail while the deny cases pass — a stub that denies everything passes six of these tests. That asymmetry is the point: **verify the accept cases fail before implementing**, or you have only tested that a broken guard is closed.

- [ ] **Step 3: Implement**

```ts
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isAllowed(email: string | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  const list = parseAllowlist(raw);
  // An empty allowlist denies everyone. The opposite default -- "nothing
  // configured, so allow" -- is a plausible reading of the same idea and
  // would hand every tenant's data to the first person who signs up.
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}
```

Then `requireSuperAdmin()`, which is the only place the env var is read:

```ts
export async function requireSuperAdmin(): Promise<{ userId: string; email: string }> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');
  if (!isAllowed(result.user.email, process.env.SUPERADMIN_EMAILS)) {
    // /library, not notFound(): a 404 here would confirm to a signed-in
    // non-admin that /admin exists and they merely lack access.
    redirect('/library');
  }
  return { userId: result.user.id, email: result.user.email };
}
```

- [ ] **Step 4: Run — all pass**

```bash
pnpm vitest run && pnpm build
```

- [ ] **Step 5: Prove the deny path is load-bearing**

Change `if (list.length === 0) return false;` to `return true;`, run `pnpm vitest run`, confirm the three "DENIES everyone" assertions fail by name, revert. Record the output — this is the mutation proof for the single most dangerous line in the plan.

- [ ] **Step 6: Set the local env var**

Add to `.env.local` (gitignored, local only — production is set in Vercel, in Task 6):

```
SUPERADMIN_EMAILS=admin@example.test
```

`admin@example.test` is the **e2e** admin. The production value is the operator's real address and is set separately.

- [ ] **Step 7: Commit**

```bash
git add src/lib/superadmin.ts src/lib/superadmin.test.ts
git commit -m "Add requireSuperAdmin and its allowlist"
```

---

### Task 2: The unscoped queries

**Files:**
- Create: `src/lib/admin-queries.ts`

**Interfaces:**
- Consumes: `getDb()`, the schema modules.
- Produces:

```ts
export interface AdminCounts {
  users: number; orgs: number; games: number; disks: number;
  blobs: number; liveInvites: number;
}
export interface AdminUserRow {
  userId: string; email: string; name: string | null; createdAt: Date;
  orgId: string | null; orgName: string | null;
  games: number; disks: number; devices: number;
}
export type InviteState = 'live' | 'consumed' | 'expired';
export interface AdminInviteRow {
  code: string; state: InviteState; createdAt: Date; expiresAt: Date;
  consumedAt: Date | null;
}

export async function adminCounts(): Promise<AdminCounts>;
export async function adminListUsers(opts: { limit: number; offset: number }): Promise<AdminUserRow[]>;
export async function adminCountUsers(): Promise<number>;
export async function adminListInvites(limit?: number): Promise<AdminInviteRow[]>;
```

- [ ] **Step 1: Write the module with its boundary comment**

This task has no Vitest tests — every function opens a database connection, and **Vitest in this repo has no `DATABASE_URL`** (a constraint recorded since plan 1). Tasks 3-5 cover these through Playwright, which is where they can actually run.

Open the file with the import boundary stated, because it is the only thing enforcing it:

```ts
// Unscoped queries. EVERY other query in this codebase goes through
// orgFilter() (src/db/scope.ts, "the single chokepoint for tenant
// isolation"); these deliberately do not, which is why they live here and
// nowhere else.
//
// IMPORT BOUNDARY: only src/app/(admin)/** and src/app/api/admin/** may
// import this module. A helper in src/lib/queries.ts that grew an unscoped
// variant would be a cross-tenant leak the same shape as the one plan 3b's
// review caught; keeping the unscoped set in a quarantined module is what
// makes that mistake visible in review rather than invisible in a diff.
```

- [ ] **Step 2: Implement `adminCounts`**

Six `count(*)` reads in one round trip. Follow `src/lib/queries.ts`'s use of `sql<number>`
with an explicit `::int` cast — Postgres returns `count(*)` as `bigint`, which arrives as a
string without it:

```ts
export async function adminCounts(): Promise<AdminCounts> {
  const [row] = await getDb().execute(sql`
    select
      (select count(*)::int from auth."user")                       as users,
      (select count(*)::int from auth.organization)                 as orgs,
      (select count(*)::int from games)                             as games,
      (select count(*)::int from disks)                             as disks,
      (select count(*)::int from blobs)                             as blobs,
      (select count(*)::int from invites
        where consumed_at is null and expires_at > now())           as live_invites
  `);
  return {
    users: Number(row.users), orgs: Number(row.orgs), games: Number(row.games),
    disks: Number(row.disks), blobs: Number(row.blobs),
    liveInvites: Number(row.live_invites),
  };
}
```

- [ ] **Step 3: Implement `adminListUsers` and `adminCountUsers`**

`auth.user` left-joined to `auth.member` and `auth.organization`, with correlated subqueries counting `games`, `disks` and `devices` for that `org_id`. Ordered by `created_at DESC` so a newly created account is on page one. `limit`/`offset` from the caller — **pagination is required**, not optional: production holds 2,862 users.

Left joins, not inner: a user whose organization bootstrap failed still has a row, and the admin list is exactly where you would want to see them. `orgId`/`orgName` are nullable for that reason.

- [ ] **Step 4: Implement `adminListInvites`**

Derive the state in SQL so the page never recomputes it from three columns and disagrees:

```ts
const state = sql<InviteState>`case
  when ${invites.consumedAt} is not null then 'consumed'
  when ${invites.expiresAt} <= now()     then 'expired'
  else 'live'
end`;
```

Order live first (`order by (state = 'live') desc, created_at desc`) so the codes the operator
can act on are at the top.

- [ ] **Step 5: Verify it compiles and commit**

```bash
pnpm build
git add src/lib/admin-queries.ts
git commit -m "Add the admin plane's unscoped queries"
```

---

### Task 3: The guard, the shell, and the overview page

**Files:**
- Create: `src/app/(admin)/layout.tsx`, `src/app/(admin)/admin/page.tsx`, `src/app/(admin)/admin/users/page.tsx`
- Create: `e2e/admin-helpers.ts`, `e2e/admin-guard.spec.ts`
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: `requireSuperAdmin()` (Task 1), `adminCounts`/`adminListUsers`/`adminCountUsers` (Task 2).
- Produces: `signInAsSuperAdmin(page): Promise<{ email: string }>` from `e2e/admin-helpers.ts`.

- [ ] **Step 1: Write the e2e helper**

`e2e/admin-helpers.ts`. The admin email is fixed (it must match `SUPERADMIN_EMAILS`), and `user.email` is unique — so the helper signs in if the account exists and signs up if it does not. First run creates it; every later run reuses it.

```ts
import { type Page, expect } from '@playwright/test';
import { mintInviteCode } from './helpers';

export const SUPERADMIN_EMAIL = 'admin@example.test';
const PASSWORD = 'correct-horse-battery-staple';

/** Sign in as the allowlisted admin, creating the account on first run. */
export async function signInAsSuperAdmin(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(SUPERADMIN_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Either we land in the app, or the account does not exist yet.
  const landed = await page.waitForURL(/\/library/, { timeout: 5_000 }).then(
    () => true, () => false,
  );
  if (!landed) {
    const code = await mintInviteCode();
    await page.goto('/sign-up');
    await page.getByLabel('Email').fill(SUPERADMIN_EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByLabel('Invite code').fill(code);
    await page.getByRole('button', { name: /sign up/i }).click();
    await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });
  }
  return { email: SUPERADMIN_EMAIL };
}
```

- [ ] **Step 2: Write the failing guard tests**

`e2e/admin-guard.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

test('a signed-in non-admin is redirected away from every admin route', async ({ page }) => {
  await signUpFresh(page);   // a random @example.test user, not the allowlisted one
  for (const route of ['/admin', '/admin/users', '/admin/invites']) {
    await page.goto(route);
    // /library, not a 404 -- the response must not confirm the route exists.
    await expect(page).toHaveURL(/\/library/);
  }
});

test('a signed-out visitor is sent to sign-in, not to the admin plane', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('the allowlisted admin sees the overview with real counts', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
  // The database has thousands of e2e users; assert the shape, not a number.
  await expect(page.getByTestId('count-users')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('count-orgs')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('count-blobs')).toHaveText(/^\d+$/);
});

test('the admin user list paginates rather than rendering thousands of rows', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  const rows = page.getByTestId('admin-user-row');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThanOrEqual(50);
});
```

- [ ] **Step 3: Run and watch them fail**

```bash
pnpm e2e e2e/admin-guard.spec.ts
```

Expected: the two admin tests fail (no `/admin` route). **The two redirect tests will pass before the routes exist** — a missing route also fails to show admin content. That is a vacuous pass. After Step 4, temporarily comment out the `requireSuperAdmin()` call in the layout, re-run, and confirm the non-admin test now *fails*; restore it. Without that, those tests assert nothing.

- [ ] **Step 4: Build the layout and pages**

`(admin)/layout.tsx` calls `requireSuperAdmin()` and renders a minimal shell — an "Admin" header and a nav across the three routes. It does **not** reuse the app shell's org switcher; there is no active org here.

`/admin` renders the six counts as labelled tiles, each with `data-testid="count-<name>"`.

`/admin/users` reads `?page=` from `searchParams` (a Promise in Next 16), 50 rows per page, each row carrying **both** `data-testid="admin-user-row"` (so a test can count rows) and
`data-testid="user-row-<email>"` (so a test can target one), showing email, org name, created
date and the three library counts, plus prev/next controls and a total. Task 5's delete tests
use the second form; keep both.

- [ ] **Step 5: Add the proxy matcher**

`src/proxy.ts`: add `'/admin/:path*'` to `config.matcher`, with a comment noting it is the same optimistic cookie check as `/library` and that `requireSuperAdmin()` is what actually enforces access.

- [ ] **Step 6: Green, then commit**

```bash
pnpm vitest run && pnpm e2e && pnpm build
git add src/app/\(admin\) src/proxy.ts e2e/admin-helpers.ts e2e/admin-guard.spec.ts
git commit -m "Add the admin shell, overview and user list"
```

---

### Task 4: Invites — issue and revoke

**Files:**
- Create: `src/app/(admin)/admin/invites/page.tsx`
- Create: `src/app/api/admin/invites/route.ts`, `src/app/api/admin/invites/[code]/route.ts`
- Create: `src/components/admin/issue-invite-button.tsx`, `revoke-invite-button.tsx`
- Create: `e2e/admin-invites.spec.ts`

**Interfaces:**
- Consumes: `requireSuperAdmin()`, `adminListInvites()`, `issueInvite()` from `@/lib/invites`.
- Produces: `POST /api/admin/invites` → `{ code }`; `DELETE /api/admin/invites/[code]` → 204, or 409 if consumed, or 404 if absent.

- [ ] **Step 1: Write the failing e2e**

`e2e/admin-invites.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

test('issuing shows a code that then appears in the list', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  await page.getByRole('button', { name: /issue invite/i }).click();
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[23456789ABCDEFGHJKMNPRSTUVWXYZ]{8}$/);
  await expect(page.getByTestId(`invite-${code}`)).toBeVisible();
});

test('a revoked code disappears and no longer works at sign-up', async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  await page.getByRole('button', { name: /issue invite/i }).click();
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';

  await page.getByTestId(`revoke-${code}`).click();
  await expect(page.getByTestId(`invite-${code}`)).toHaveCount(0);

  // The real proof: it is dead as a credential, not merely hidden.
  await page.context().clearCookies();
  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(`revoked-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByLabel('Invite code').fill(code);
  await page.getByRole('button', { name: /sign up/i }).click();
  await expect(page.getByText(/invalid or already used/i)).toBeVisible();
});

test('a consumed code cannot be revoked', async ({ page, request }) => {
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  await page.getByRole('button', { name: /issue invite/i }).click();
  const code = (await page.getByTestId('new-invite-code').textContent())?.trim() ?? '';

  // Consume it by signing somebody up, then try to revoke it as admin.
  const consumer = await page.context().browser()!.newPage();
  await consumer.goto('/sign-up');
  await consumer.getByLabel('Email').fill(`consumer-${Date.now()}@example.test`);
  await consumer.getByLabel('Password').fill('correct-horse-battery-staple');
  await consumer.getByLabel('Invite code').fill(code);
  await consumer.getByRole('button', { name: /sign up/i }).click();
  await expect(consumer).toHaveURL(/\/library/, { timeout: 15_000 });
  await consumer.close();

  const res = await page.request.delete(`/api/admin/invites/${code}`);
  expect(res.status()).toBe(409);
});

test('a non-admin cannot reach the invite API even though the page guard is separate', async ({ page }) => {
  await signUpFresh(page);
  const post = await page.request.post('/api/admin/invites');
  expect([302, 401, 403, 404]).toContain(post.status());
  const del = await page.request.delete('/api/admin/invites/AAAAAAAA');
  expect([302, 401, 403, 404]).toContain(del.status());
});
```

- [ ] **Step 2: Run, watch each fail. Step 3: Implement.**

`POST /api/admin/invites` calls `requireSuperAdmin()`, then `issueInvite(orgId, userId)` — the admin's own org, looked up the same way `requireOrg` does, since `requireSuperAdmin` deliberately returns no `orgId`. Returns `{ code }`.

`DELETE /api/admin/invites/[code]` calls `requireSuperAdmin()`, then deletes **only** where `consumed_at IS NULL`. A consumed row returns **409**, not a silent success — it is the record that an account was created, and the operator should be told the difference. An absent code is 404.

The page lists all three states with `data-testid="invite-<code>"`, a revoke button per live row (`data-testid="revoke-<code>"`), and shows a newly issued code in `data-testid="new-invite-code"`.

- [ ] **Step 4: Green, mutate, commit.**

Mutation proof: make the DELETE ignore `consumed_at`, confirm `a consumed code cannot be revoked` fails, revert.

```bash
git commit -m "Add invite issue and revoke to the admin plane"
```

---

### Task 5: Cascade delete

The destructive one. Its own task because a reviewer should be able to reject it alone.

**Files:**
- Create: `src/lib/admin-delete.ts`, `src/app/api/admin/users/[id]/route.ts`
- Create: `src/components/admin/delete-user-dialog.tsx`
- Create: `e2e/admin-delete.spec.ts`
- Modify: `src/app/(admin)/admin/users/page.tsx`

**Interfaces:**
- Produces: `deleteUserCascade(userId: string): Promise<{ orgId: string | null; games: number; disks: number; devices: number }>` — returns what it removed.

- [ ] **Step 1: Write the failing e2e**

`e2e/admin-delete.spec.ts`. **The blob assertion is the point of this file** — without it the test passes against an implementation that deletes blobs and corrupts another tenant.

```ts
import { test, expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs, games, disks } from '@/db/schema/catalog';
import { randomUUID } from 'node:crypto';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';

test.afterAll(cleanupSeeded);

test('deleting a user removes their library but never a shared blob', async ({ page, browser }) => {
  // One sha256, deliberately shared by two orgs -- seedDisk's blobs insert is
  // onConflictDoNothing, so the second org reuses the same blob row. This is
  // the dedupe case the parent spec records as already live (26+ shared blobs).
  const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');

  const victim = await signUpFresh(page);
  await seedDisk(victim.orgId, { title: `Victim ${Date.now()}`, diskNo: 1, sha256 });

  const other = await browser.newPage();
  const otherUser = await signUpFresh(other);
  await seedDisk(otherUser.orgId, { title: `Other ${Date.now()}`, diskNo: 1, sha256 });
  await other.close();

  const db = getDb();
  expect((await db.select().from(blobs).where(eq(blobs.sha256, sha256))).length).toBe(1);

  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await page.getByTestId(`delete-user-${victim.email}`).click();
  await page.getByLabel(/type the email/i).fill(victim.email);
  await page.getByRole('button', { name: /delete permanently/i }).click();
  await expect(page.getByTestId(`user-row-${victim.email}`)).toHaveCount(0);

  // Their catalog rows are gone...
  const leftoverGames = await db.select().from(games).where(eq(games.orgId, victim.orgId));
  const leftoverDisks = await db.select().from(disks).where(eq(disks.orgId, victim.orgId));
  expect(leftoverGames).toHaveLength(0);
  expect(leftoverDisks).toHaveLength(0);

  // ...and the shared blob survived. Deleting it would corrupt the other org.
  const blob = await db.select().from(blobs).where(eq(blobs.sha256, sha256));
  expect(blob).toHaveLength(1);
});

test('the dialog refuses until the email is typed exactly', async ({ page }) => {
  const victim = await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/users');
  await page.getByTestId(`delete-user-${victim.email}`).click();
  await expect(page.getByRole('button', { name: /delete permanently/i })).toBeDisabled();
  await page.getByLabel(/type the email/i).fill('not-the-email@example.test');
  await expect(page.getByRole('button', { name: /delete permanently/i })).toBeDisabled();
  await page.getByLabel(/type the email/i).fill(victim.email);
  await expect(page.getByRole('button', { name: /delete permanently/i })).toBeEnabled();
});

test('a non-admin cannot delete a user through the API', async ({ page }) => {
  await signUpFresh(page);
  // The id is deliberately one that does not exist: the guard must reject
  // before any lookup, so a 404-because-missing would be the wrong reason to
  // pass. Route param is a USER id, not an org id.
  const res = await page.request.delete('/api/admin/users/usr_does_not_exist');
  expect([302, 401, 403, 404]).toContain(res.status());
});
```

`seedDisk(orgId, { title, diskNo, sha256 })` already exists in `e2e/device-helpers.ts`, already
takes an explicit `sha256`, and already inserts the blob with `onConflictDoNothing` — so two
orgs sharing one blob needs no new helper, just the same digest passed twice. It also registers
what it created with `cleanupSeeded`.

- [ ] **Step 2: Run, watch each fail. Step 3: Implement `admin-delete.ts`.**

One transaction. Resolve the user's `orgId` first, then delete in this order, all scoped to that `orgId`:

```
entitlements → games → disks → devices → pairing_codes → invites → auth.user
```

`auth.user` cascades to `auth.member` and the organization. **`blobs` is never in this list**, and the file says why at the top:

```ts
// blobs is deliberately absent and must stay absent. It is keyed by sha256
// alone, has no orgId, and is the content-addressed dedupe store -- the
// parent spec records 26+ blobs already shared across organizations.
// Deleting one because this tenant held the last reference would silently
// corrupt a different tenant's library, turning a cleanup into data loss for
// someone who did nothing. Orphaned blobs are a storage cost, not a
// correctness problem; reclaiming them needs cross-org reference counting
// and is backlog (spec S8).
```

A user with no organization (bootstrap failed) deletes cleanly: `orgId` is null, the catalog deletes are skipped, the auth row goes.

- [ ] **Step 4: Green, then mutate — twice.**

First: add `blobs` to the delete set, run, confirm `never a shared blob` fails by name, revert. Second: drop the `orgId` predicate from the `games` delete, run, confirm the *other* org's data is affected — if no test catches that, add one, because an unscoped delete here destroys every tenant.

- [ ] **Step 5: Commit**

```bash
git commit -m "Add the admin cascade delete, and the blob it must not touch"
```

---

### Task 6: The bootstrap runbook and the docs

**Files:**
- Modify: `HANDOFF.md`, `docs/superpowers/specs/2026-08-31-super-admin-plane-design.md`

- [ ] **Step 1: Write the runbook into `HANDOFF.md`**

Under a new "Super-admin plane" section, the ordering from spec §3, stated as a sequence with the reason attached — **because doing it out of order leaves the operator's address claimable**:

1. The operator signs up and claims `sfs@enhance-it.dk` (invite-only; use a live code).
2. Revoke the four codes that leaked into a session transcript: `M3W4V3BA`, `K69GXH72`, `HXGMH4ZK`, `56DTUDMA`.
3. `vercel env add SUPERADMIN_EMAILS production` → `sfs@enhance-it.dk`.
4. Redeploy.

Also record: `SUPERADMIN_EMAILS` is required in `.env.local` for local dev and e2e (`admin@example.test`), and that an unset variable denies everyone rather than allowing them.

- [ ] **Step 2: Mark the spec delivered**, stating what shipped and that blob GC remains backlog.

- [ ] **Step 3: Commit**

```bash
git commit -m "Record the super-admin plane as delivered"
```

---

## Done when

- `pnpm vitest run` green, `pnpm e2e` green, `pnpm build` clean.
- The allowlist's deny-on-empty was observed to fail its named tests when inverted.
- The cascade delete was observed to fail `never a shared blob` when `blobs` is added to the delete set.
- A non-admin was observed to be rejected by each `/api/admin/*` route independently of the page guard.
- `SUPERADMIN_EMAILS` is set in Vercel production, and the operator's email is claimed.
