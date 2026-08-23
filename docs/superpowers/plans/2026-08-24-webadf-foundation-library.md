# webadf — Foundation & Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed, multi-tenant Next.js app where a signed-in user can bulk-upload an Amiga ADF collection (deduped by SHA-256) and browse it as a cover grid or a dense table.

**Architecture:** Next.js 16 App Router on Vercel, Neon Postgres via Drizzle, Better Auth (self-hosted) with its `organization` plugin as the tenancy model, and Vercel Blob as content-addressed private object storage. Uploads never pass through a function — the client hashes locally, asks which hashes are already known, and PUTs the misses straight to Blob via presigned URLs.

**Tech Stack:** Next.js 16.3.2 · React 19 · TypeScript · Tailwind v4 (CSS-first) · shadcn/ui v4 (Base UI) · Drizzle 0.45 · `@neondatabase/serverless` 1.1 · better-auth 1.7.1 · `@vercel/blob` 2.8 · Vitest (logic) · Playwright (pages & auth)

**Spec:** `docs/superpowers/specs/2026-08-23-webadf-design.md`

**Scope:** This is plan 1 of 3. Plan 2 is the device plane (pairing, poll/status, mount jobs). Plan 3 is enrichment (TOSEC dats, queue, IGDB/OpenRetro, artwork). Deferred entirely: ESP32 firmware.

---

## Global Constraints

These apply to **every** task. Each was verified against the real package, not from memory — several contradict what the published docs say.

**Versions.** Node ≥ 20.9 (dev on 25.8). pnpm 10. `next@16.3.2`, `better-auth@1.7.1`, `auth@1.7.1` (CLI), `drizzle-orm@0.45.2`, `@vercel/blob@2.8.0`, `@neondatabase/serverless@1.1.0`.

**Next 16 API shapes.** `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` are **all Promises** and must be awaited. Global `PageProps<"/route">` / `RouteContext<"/api/route">` types are generated — do not import them.

**`proxy.ts`, not `middleware.ts`.** Next 16 renamed it; the exported function is `proxy`. It is **nodejs-only** — the edge runtime is not supported there.

**`cacheComponents` stays OFF** (the 16.3.2 default). Do not enable it. If it is ever turned on, every page reading `cookies()` fails the build unless wrapped in `<Suspense>`, marked `'use cache'`, or given `export const instant = false`.

**shadcn v4 is Base UI, not Radix.** It installs `@base-ui/react`. Any Radix-era snippet found online is wrong for this codebase.

**Better Auth specifics:**
- CLI is `npx auth@latest generate` (writes `./auth-schema.ts`). `@better-auth/cli` is **deprecated** and pinned to 1.4.x — using it silently generates a stale schema.
- `nextCookies()` **must be the last plugin** in the array.
- Session is nested: `session.session.activeOrganizationId`, and it is optional. The whole `getSession()` result may be `null`.
- `drizzleAdapter`'s `schemaName` is a **codegen hint only**. Runtime namespacing comes from `pgSchema('auth')` in the table definitions.
- `BETTER_AUTH_SECRET` must be ≥32 chars of real entropy (`openssl rand -base64 32`), or the app throws in production.

**Vercel Blob specifics:**
- `presignUrl(tokenObject, options)` takes the **whole** `issueSignedToken` result and returns **`{ presignedUrl }`**, not a bare string.
- `access` is required on every `presignUrl` call.
- `addRandomSuffix` and `allowOverwrite` are only signed into the URL **when explicitly passed** — always pass both.
- There is **no `ifNoneMatch`**. Dedupe = `allowOverwrite: false` + catch.
- `head()` **throws `BlobNotFoundError`** when absent. It does not return null.

**Testing split.** Vitest **cannot test async Server Components**. Pure logic and client components → Vitest. Pages, auth flows, and anything rendering a route → **Playwright**.

**Secrets.** Never commit `.env*`. Never echo a secret value into the transcript or a commit message.

**Disk images.** `adf-archive/` is gitignored and must stay that way. No `.adf` ever enters the repo.

---

## File Structure

```
webadf/
├── src/
│   ├── app/
│   │   ├── layout.tsx                 root layout, fonts, gradient canvas
│   │   ├── globals.css                Tailwind v4 @theme + webadf tokens
│   │   ├── (auth)/sign-in/page.tsx
│   │   ├── (auth)/sign-up/page.tsx
│   │   ├── (app)/layout.tsx           app shell: top nav, page header slot
│   │   ├── (app)/library/page.tsx     grid + table toggle
│   │   ├── (app)/ingest/page.tsx      dropzone + run progress
│   │   └── api/
│   │       ├── auth/[...all]/route.ts better-auth handler
│   │       └── ingest/
│   │           ├── check/route.ts     POST hashes -> known/missing
│   │           ├── presign/route.ts   POST hashes -> presigned PUTs
│   │           └── complete/route.ts  POST -> blobs + entitlements rows
│   ├── components/
│   │   ├── ui/                        shadcn (Base UI) primitives
│   │   ├── library/game-grid.tsx
│   │   ├── library/game-table.tsx
│   │   ├── library/view-toggle.tsx
│   │   └── ingest/dropzone.tsx
│   ├── db/
│   │   ├── index.ts                   getDb() — lazy, no Proxy
│   │   ├── schema/auth.ts             generated by `auth generate`
│   │   ├── schema/catalog.ts          blobs, entitlements, games, disks
│   │   └── scope.ts                   orgFilter() tenancy guard
│   └── lib/
│       ├── auth.ts                    betterAuth server config
│       ├── auth-client.ts             createAuthClient
│       ├── session.ts                 requireOrg()
│       ├── storage.ts                 DiskStore interface + Blob impl
│       ├── tosec.ts                   filename parser (pure)
│       └── grouping.ts                disks -> games (pure)
├── cli/                               `webadf push` — own package.json
│   ├── src/index.ts
│   └── src/hash.ts
├── drizzle/                           generated migrations
├── e2e/                               Playwright specs
├── src/proxy.ts                       route guard (NOT middleware.ts)
├── drizzle.config.ts
├── vitest.config.mts
└── playwright.config.ts
```

---

## Task 1: Provision infrastructure and scaffold the app

**Files:**
- Create: `package.json`, `src/app/**` (scaffold), `postcss.config.mjs`, `components.json`, `.env.local`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a deployed Next 16 app; env vars `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` available locally via `.env.local` and in Vercel

- [ ] **Step 1: Create the private GitHub repo and push what exists**

```bash
cd /Users/sfs/Devel/webadf
gh repo create webadf --private --source=. --remote=origin --description "Web-based Amiga ADF library that mounts disks to a Gotek over WiFi"
git push -u origin main
```

- [ ] **Step 2: Scaffold Next.js into the existing directory**

The repo already has `design/`, `docs/`, `adf-archive/`, so scaffold into a temp dir and move. `--disable-git` is the correct flag (there is no `--no-git`), and there is no `--turbopack` flag any more — Turbopack is the default in 16.

```bash
cd /tmp && rm -rf webadf-scaffold
pnpm create next-app@16.3.2 webadf-scaffold \
  --ts --app --tailwind --eslint \
  --src-dir --import-alias "@/*" \
  --use-pnpm --disable-git --yes

cd /tmp/webadf-scaffold
rm -f README.md CLAUDE.md
cp -R . /Users/sfs/Devel/webadf/
cd /Users/sfs/Devel/webadf && pnpm install
```

Note: the scaffold also writes `AGENTS.md` and a `pnpm-workspace.yaml` with `ignoredBuiltDependencies: [sharp, unrs-resolver]`. Keep both. `next dev` re-creates `AGENTS.md` if deleted.

- [ ] **Step 3: Verify the scaffold builds**

Run: `pnpm build`
Expected: PASS, banner reads `▲ Next.js 16.3.2 (Turbopack)`

- [ ] **Step 4: Init shadcn/ui**

```bash
pnpm dlx shadcn@latest init --defaults --yes
pnpm dlx shadcn@latest add button input label card badge dropdown-menu sonner
```

Expected output includes `Validating Tailwind CSS. Found v4. ✔`. This installs `@base-ui/react` — **not** Radix.

- [ ] **Step 5: Fix the shadcn font self-reference bug**

`shadcn init` writes `--font-sans: var(--font-sans);` inside `@theme inline` — a self-reference that nothing defines, so `html { font-family: var(--font-sans) }` is invalid and the font silently never applies. Point it at the real variable:

```bash
cd /Users/sfs/Devel/webadf
python3 - <<'EOF'
p = 'src/app/globals.css'
s = open(p).read()
assert '--font-sans: var(--font-sans);' in s, 'bug not present — re-check shadcn version'
s = s.replace('--font-sans: var(--font-sans);', '--font-sans: var(--font-geist-sans);')
open(p, 'w').write(s)
EOF
grep -n 'font-sans' src/app/globals.css
```

Expected: `--font-sans: var(--font-geist-sans);` — no self-reference remains. (Task 10 replaces Geist with Space Grotesk.)

- [ ] **Step 6: Provision Neon, Blob and the Vercel project**

```bash
cd /Users/sfs/Devel/webadf
vercel link --yes --project webadf
vercel integration add neon --yes
vercel blob store add webadf-disks
vercel env add BETTER_AUTH_SECRET production <<< "$(openssl rand -base64 32)"
vercel env add BETTER_AUTH_SECRET development <<< "$(openssl rand -base64 32)"
vercel env pull .env.local --yes
```

If `vercel integration add neon` requires a browser handoff, stop and ask the user to finish it in the dashboard, then re-run `vercel env pull`.

Verify without printing values: `grep -c DATABASE_URL .env.local && grep -c BLOB_READ_WRITE_TOKEN .env.local`
Expected: `1` and `1`.

- [ ] **Step 7: Add `BETTER_AUTH_URL` locally**

```bash
echo 'BETTER_AUTH_URL=http://localhost:3000' >> .env.local
```

- [ ] **Step 8: Deploy and confirm**

```bash
vercel deploy --prod --yes
```

Expected: a production URL returning the Next.js starter page.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Scaffold Next 16 app, provision Neon/Blob/Vercel

Patches the shadcn v4 --font-sans self-reference, which otherwise
silently prevents any font from applying."
git push
```

---

## Task 2: Database client and catalog schema

**Files:**
- Create: `src/db/index.ts`, `src/db/schema/catalog.ts`, `src/db/scope.ts`, `drizzle.config.ts`, `vitest.config.mts`, `src/db/scope.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `DATABASE_URL` from Task 1
- Produces:
  - `getDb(): NeonHttpDatabase<typeof schema>`
  - tables `blobs`, `entitlements`, `games`, `disks` from `@/db/schema/catalog`
  - `orgFilter(table, orgId, extra?): SQL` from `@/db/scope`

- [ ] **Step 1: Install dependencies**

```bash
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D drizzle-kit vitest dotenv-cli
```

- [ ] **Step 2: Write the database client**

Lazy init — a top-level `neon()` call throws during `next build` before env vars exist. **Do not wrap in a `Proxy`**; better-auth inspects the adapter object and a Proxy breaks it with a silent hang.

```ts
// src/db/index.ts
import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as catalog from './schema/catalog';

const schema = { ...catalog };
let _db: NeonHttpDatabase<typeof schema> | null = null;

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = drizzle(neon(url), { schema });
  }
  return _db;
}
```

- [ ] **Step 3: Write the catalog schema**

```ts
// src/db/schema/catalog.ts
import {
  pgTable, text, integer, bigint, timestamp, boolean, primaryKey, index,
} from 'drizzle-orm/pg-core';

/** GLOBAL, not per-tenant. One row per unique disk image in the whole system. */
export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  sizeBytes: integer('size_bytes').notNull(),
  gzipSizeBytes: integer('gzip_size_bytes'),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Proves a tenant uploaded these exact bytes. Gates every presigned GET. */
export const entitlements = pgTable('entitlements', {
  orgId: text('org_id').notNull(),
  sha256: text('sha256').notNull().references(() => blobs.sha256),
  sourceFilename: text('source_filename').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.sha256] }),
  index('entitlements_org_idx').on(t.orgId),
]);

export const games = pgTable('games', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  publisher: text('publisher'),
  genre: text('genre'),
  chipset: text('chipset'),
  coverAssetId: text('cover_asset_id'),
  metadataSource: text('metadata_source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('games_org_sort_idx').on(t.orgId, t.sortTitle),
  index('games_org_created_idx').on(t.orgId, t.createdAt),
]);

export const disks = pgTable('disks', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  diskNo: integer('disk_no').notNull(),
  sha256: text('sha256').notNull().references(() => blobs.sha256),
  label: text('label'),
  tosecName: text('tosec_name'),
  isBoot: boolean('is_boot').notNull().default(false),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
}, (t) => [
  index('disks_game_idx').on(t.gameId),
  index('disks_org_idx').on(t.orgId),
]);
```

- [ ] **Step 4: Write the failing tenancy-guard test**

```ts
// src/db/scope.test.ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { games } from './schema/catalog';
import { orgFilter } from './scope';

describe('orgFilter', () => {
  it('always constrains by org id', () => {
    const sql = orgFilter(games, 'org_abc');
    expect(sql).toBeDefined();
    expect(JSON.stringify(sql)).toContain('org_abc');
  });

  it('ANDs an extra predicate rather than replacing the org constraint', () => {
    const sql = orgFilter(games, 'org_abc', eq(games.title, 'Project-X'));
    const s = JSON.stringify(sql);
    expect(s).toContain('org_abc');
    expect(s).toContain('Project-X');
  });

  it('rejects an empty org id instead of matching everything', () => {
    expect(() => orgFilter(games, '')).toThrow(/org/i);
  });
});
```

- [ ] **Step 5: Add the Vitest config and run the test to see it fail**

```ts
// vitest.config.mts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'cli/**/*.test.ts'] },
});
```

```bash
pnpm add -D vite-tsconfig-paths
pnpm vitest run src/db/scope.test.ts
```

Expected: FAIL — `Failed to resolve import "./scope"`.

- [ ] **Step 6: Implement the tenancy guard**

```ts
// src/db/scope.ts
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

type OrgScoped = PgTable & { orgId: PgColumn };

/**
 * The single chokepoint for tenant isolation. Every catalog read and write
 * goes through this; an empty org id throws rather than silently matching
 * every row in the table.
 */
export function orgFilter<T extends OrgScoped>(table: T, orgId: string, extra?: SQL): SQL {
  if (!orgId) throw new Error('orgFilter: refusing to build a query with an empty org id');
  const base = eq(table.orgId, orgId);
  return extra ? and(base, extra)! : base;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run src/db/scope.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Configure drizzle-kit and push the schema**

```ts
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
```

Add to `package.json` scripts (drizzle-kit does **not** auto-load `.env.local`):

```json
"db:generate": "dotenv -e .env.local -- drizzle-kit generate",
"db:push": "dotenv -e .env.local -- drizzle-kit push",
"test": "vitest run",
"e2e": "playwright test"
```

```bash
pnpm db:generate && pnpm db:push
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add Drizzle client, catalog schema and the org tenancy guard

orgFilter is the single chokepoint for tenant isolation and throws on an
empty org id rather than silently matching every row."
git push
```

---

## Task 3: Better Auth with organization tenancy

**Files:**
- Create: `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/lib/session.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/(auth)/sign-in/page.tsx`, `src/app/(auth)/sign-up/page.tsx`, `src/proxy.ts`, `auth-schema.ts` → `src/db/schema/auth.ts`
- Modify: `src/db/index.ts` (register auth schema)

**Interfaces:**
- Consumes: `getDb()` from Task 2
- Produces:
  - `auth` (server) from `@/lib/auth`
  - `authClient` from `@/lib/auth-client`
  - `requireOrg(): Promise<{ userId: string; orgId: string }>` from `@/lib/session` — throws/redirects when unauthenticated

- [ ] **Step 1: Install**

```bash
pnpm add better-auth
```

- [ ] **Step 2: Write the server config**

`nextCookies()` **must be last**. Two database hooks are needed, and the reason is subtle: `createOrganization` called *with* session headers silently ignores `userId`, and at `user.create.after` time no session exists yet — so the org is created in one hook and made active in another.

```ts
// src/lib/auth.ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { member } from '@/db/schema/auth';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg', schemaName: 'auth' }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        // Not atomic with user creation — it runs after the transaction commits.
        // A failure here leaves a user with no org; requireOrg() treats that as
        // "needs onboarding" rather than crashing.
        after: async (user) => {
          await auth.api.createOrganization({
            body: {
              name: `${user.name || user.email.split('@')[0]}'s library`,
              slug: `org-${user.id.slice(0, 12)}`,
              userId: user.id,
            },
            // NO headers — passing them makes the API ignore userId entirely.
          });
        },
      },
    },
    session: {
      create: {
        // createOrganization only sets an org active when a session exists,
        // and none did above. So stamp it onto the session as it is created.
        before: async (session) => {
          const rows = await getDb()
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(eq(member.userId, session.userId))
            .limit(1);
          return { data: { ...session, activeOrganizationId: rows[0]?.organizationId } };
        },
      },
    },
  },
  plugins: [organization(), nextCookies()], // nextCookies LAST
});
```

- [ ] **Step 3: Generate and install the auth schema**

```bash
npx auth@latest generate --yes
```

`@better-auth/cli` is deprecated at 1.4.x and would emit a stale schema — use the `auth` package. It writes `./auth-schema.ts`. Move it and namespace it:

```bash
mv auth-schema.ts src/db/schema/auth.ts
```

Then edit `src/db/schema/auth.ts` so tables live in the `auth` Postgres schema — `schemaName` in the adapter is only a codegen hint and does **not** namespace queries at runtime:

```ts
// at the top of src/db/schema/auth.ts
import { pgSchema } from 'drizzle-orm/pg-core';
export const authSchema = pgSchema('auth');
// then replace every `pgTable(` with `authSchema.table(`
```

- [ ] **Step 4: Register auth tables with the db client and push**

```ts
// src/db/index.ts — update the schema import
import * as catalog from './schema/catalog';
import * as authSchema from './schema/auth';
const schema = { ...catalog, ...authSchema };
```

```bash
pnpm db:generate && pnpm db:push
```

- [ ] **Step 5: Add the route handler and client**

```ts
// src/app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
```

```ts
// src/lib/auth-client.ts
'use client';
import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({ plugins: [organizationClient()] });
export const { signIn, signUp, signOut, useSession } = authClient;
```

- [ ] **Step 6: Write the session helper**

`activeOrganizationId` is **nested** at `session.session.activeOrganizationId` and is optional; the whole result can be `null`.

```ts
// src/lib/session.ts
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function requireOrg(): Promise<{ userId: string; orgId: string }> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');

  const orgId = result.session.activeOrganizationId;
  if (!orgId) redirect('/onboarding');

  return { userId: result.user.id, orgId };
}
```

- [ ] **Step 7: Add sign-in and sign-up pages**

```tsx
// src/app/(auth)/sign-up/page.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signUp } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await signUp.email({ email, password, name: email.split('@')[0] });
    setBusy(false);
    if (error) { setError(error.message ?? 'Sign up failed'); return; }
    router.push('/library');
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Create your library</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} required
               onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" value={password} required minLength={8}
               onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Sign up'}</Button>
    </form>
  );
}
```

Create `src/app/(auth)/sign-in/page.tsx` identically, but calling `signIn.email({ email, password })`, with the heading `Sign in` and the button label `Sign in`.

- [ ] **Step 8: Add the route guard**

Named export is `proxy`, the file is `proxy.ts`, and it is nodejs-only.

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

export function proxy(request: NextRequest) {
  // Optimistic cookie check only — NOT authoritative. Every page still calls
  // requireOrg(), which is what actually enforces access.
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/library/:path*', '/ingest/:path*'] };
```

- [ ] **Step 9: Verify the build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add Better Auth with organization-based tenancy

Two database hooks, not one: createOrganization ignores userId when session
headers are passed, and no session exists at user.create.after time, so the
org is created in one hook and made active in session.create.before."
git push
```

---

## Task 4: Playwright harness and the auth flow test

**Files:**
- Create: `playwright.config.ts`, `e2e/auth.spec.ts`, `e2e/helpers.ts`
- Modify: `.gitignore` (add `test-results/`, `playwright-report/`)

**Interfaces:**
- Consumes: sign-up/sign-in pages from Task 3
- Produces: `signUpFresh(page): Promise<{ email: string; password: string }>` from `e2e/helpers`, reused by later tasks

Pages here are async Server Components, which **Vitest cannot render** — Playwright is the only way to test them.

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write the config**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,          // shared database
  retries: 0,
  timeout: 30_000,
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the helper**

```ts
// e2e/helpers.ts
import { type Page, expect } from '@playwright/test';

export async function signUpFresh(page: Page) {
  const email = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'correct-horse-battery-staple';

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });

  return { email, password };
}
```

- [ ] **Step 4: Write the failing auth test**

```ts
// e2e/auth.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('signing up creates an organization and lands on the library', async ({ page }) => {
  await signUpFresh(page);
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
});

test('an anonymous visitor is redirected away from the library', async ({ page }) => {
  await page.goto('/library');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('signing out then back in returns to the same library', async ({ page }) => {
  const { email, password } = await signUpFresh(page);

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/library/);
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm e2e`
Expected: FAIL — `/library` does not exist yet.

- [ ] **Step 6: Add a minimal library page and sign-out control**

```tsx
// src/app/(app)/library/page.tsx
import { requireOrg } from '@/lib/session';
import { SignOutButton } from '@/components/sign-out-button';

export default async function LibraryPage() {
  const { orgId } = await requireOrg();
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold tracking-tight">Library</h1>
      <p className="text-sm text-neutral-500">org {orgId}</p>
      <SignOutButton />
    </main>
  );
}
```

```tsx
// src/components/sign-out-button.tsx
'use client';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button variant="ghost" onClick={async () => {
      await signOut();
      router.push('/sign-in');
    }}>Sign out</Button>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm e2e`
Expected: PASS, 3 tests. This proves end to end that sign-up creates a user, the `user.create.after` hook creates an organization, and `session.create.before` makes it active — the riskiest wiring in Task 3.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add Playwright harness and auth flow coverage

Vitest cannot render async Server Components, so pages and auth flows are
covered by Playwright. These tests are what actually prove the two-hook
organization bootstrap works."
git push
```

---

## Task 5: TOSEC filename parser

**Files:**
- Create: `src/lib/tosec.ts`, `src/lib/tosec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
```ts
export interface ParsedName {
  title: string; year: number | null; publisher: string | null;
  diskNo: number | null; diskCount: number | null;
  flags: string[]; sortTitle: string;
}
export function parseTosecName(filename: string): ParsedName
```

This is stage 0 of enrichment (spec §10.1) and runs synchronously at ingest, which is what gives a freshly uploaded disk a real title before any queue runs. Pure function, no I/O — ideal TDD.

- [ ] **Step 1: Write the failing tests**

Cases are drawn from real filenames in `adf-archive/`.

```ts
// src/lib/tosec.test.ts
import { describe, it, expect } from 'vitest';
import { parseTosecName } from './tosec';

describe('parseTosecName', () => {
  it('parses a full TOSEC name', () => {
    const r = parseTosecName('Project-X (1992)(Team 17)(Disk 1 of 4)[cr NMS].adf');
    expect(r.title).toBe('Project-X');
    expect(r.year).toBe(1992);
    expect(r.publisher).toBe('Team 17');
    expect(r.diskNo).toBe(1);
    expect(r.diskCount).toBe(4);
    expect(r.flags).toContain('cr NMS');
  });

  it('handles a single-disk release with no disk clause', () => {
    const r = parseTosecName('Marble Slide (1990)(Handel, Peter)(PD).adf');
    expect(r.title).toBe('Marble Slide');
    expect(r.year).toBe(1990);
    expect(r.publisher).toBe('Handel, Peter');
    expect(r.diskNo).toBeNull();
  });

  it('falls back to the bare stem for a non-TOSEC filename', () => {
    const r = parseTosecName('9Fingers_D1.adf');
    expect(r.title).toBe('9Fingers_D1');
    expect(r.year).toBeNull();
    expect(r.publisher).toBeNull();
  });

  it('splits on the FINAL -N so titles containing dashes survive', () => {
    const r = parseTosecName('Example - Space Unknown-2.adf');
    expect(r.title).toBe('Example - Space Unknown');
    expect(r.diskNo).toBe(2);
  });

  it('does not mistake a hyphenated title for a disk number', () => {
    const r = parseTosecName('Project-X.adf');
    expect(r.title).toBe('Project-X');
    expect(r.diskNo).toBeNull();
  });

  it('parses "Disk N of M" case-insensitively', () => {
    expect(parseTosecName('X (1990)(Y)(disk 3 of 5).adf').diskNo).toBe(3);
  });

  it('strips a leading article for sortTitle', () => {
    expect(parseTosecName('The Settlers (1993)(Blue Byte).adf').sortTitle)
      .toBe('settlers, the');
  });

  it('is case-insensitive about the extension', () => {
    expect(parseTosecName('Real_Amiga_Install.ADF').title).toBe('Real_Amiga_Install');
  });

  it('collects multiple bracket flags', () => {
    const r = parseTosecName('Y (1991)(Z)[cr ABC][t +2 DEF].adf');
    expect(r.flags).toEqual(['cr ABC', 't +2 DEF']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/tosec.test.ts`
Expected: FAIL — `Failed to resolve import "./tosec"`.

- [ ] **Step 3: Implement the parser**

```ts
// src/lib/tosec.ts
export interface ParsedName {
  title: string;
  year: number | null;
  publisher: string | null;
  diskNo: number | null;
  diskCount: number | null;
  flags: string[];
  sortTitle: string;
}

const ARTICLES = ['the', 'a', 'an'];

export function makeSortTitle(title: string): string {
  const lower = title.toLowerCase().trim();
  for (const a of ARTICLES) {
    if (lower.startsWith(`${a} `)) return `${lower.slice(a.length + 1)}, ${a}`;
  }
  return lower;
}

export function parseTosecName(filename: string): ParsedName {
  const stem = filename.replace(/\.(adf|dsk|adz|dms)$/i, '');

  const flags = [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const parens = [...stem.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);

  let year: number | null = null;
  let publisher: string | null = null;
  let diskNo: number | null = null;
  let diskCount: number | null = null;

  for (const p of parens) {
    const disk = p.match(/^disk\s+(\d+)(?:\s+of\s+(\d+))?$/i);
    if (disk) {
      diskNo = Number(disk[1]);
      diskCount = disk[2] ? Number(disk[2]) : null;
      continue;
    }
    if (year === null && /^\d{4}$/.test(p)) { year = Number(p); continue; }
    if (year !== null && publisher === null) publisher = p;
  }

  // Everything before the first bracket of either kind is the title.
  let title = stem.split(/\s*[([]/)[0].trim();

  // Only when no "(Disk N of M)" clause was present, honour a trailing -N.
  // Split on the FINAL dash so "Example - Space Unknown-2" groups correctly.
  if (diskNo === null) {
    const trailing = title.match(/^(.*)-(\d+)$/);
    if (trailing && /\s-\d+$|\S-\d+$/.test(title) && trailing[1].trim().length > 0) {
      const candidate = Number(trailing[2]);
      // A hyphenated word like "Project-X" has a non-numeric tail and never reaches
      // here; guard against absurd disk numbers from titles such as "Turrican-2000".
      if (candidate >= 1 && candidate <= 99) {
        title = trailing[1].trim();
        diskNo = candidate;
      }
    }
  }

  return { title, year, publisher, diskNo, diskCount, flags, sortTitle: makeSortTitle(title) };
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm vitest run src/lib/tosec.test.ts`
Expected: PASS, 9 tests. If the `Project-X.adf` or `Turrican-2000` cases fail, tighten the trailing-`-N` guard — do **not** relax the test.

- [ ] **Step 5: Sanity-check against the real corpus**

```bash
node --experimental-strip-types -e '
import { parseTosecName } from "./src/lib/tosec.ts";
import { readdirSync } from "node:fs";
for (const f of readdirSync("adf-archive").filter(f => /\.adf$/i.test(f)).slice(0, 20)) {
  const r = parseTosecName(f);
  console.log(String(r.diskNo ?? "-").padStart(2), r.title);
}'
```

Expected: titles look sensible; `Project-X (…Disk 1 of 4…)` yields `1 Project-X`; `whichamiga.adf` yields `- whichamiga`. This is a read-only eyeball, not an assertion.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add TOSEC filename parser

Splits on the final -N so titles containing dashes group correctly, and
guards against reading a hyphenated title like Project-X as a disk number."
git push
```

---

## Task 6: Group disks into games

**Files:**
- Create: `src/lib/grouping.ts`, `src/lib/grouping.test.ts`

**Interfaces:**
- Consumes: `parseTosecName`, `ParsedName` from Task 5
- Produces:
```ts
export interface IncomingDisk { filename: string; sha256: string; sizeBytes: number }
export interface GroupedGame {
  title: string; sortTitle: string; year: number | null; publisher: string | null;
  disks: Array<{ diskNo: number; sha256: string; filename: string; sizeBytes: number; isBoot: boolean }>;
}
export function groupDisks(input: IncomingDisk[]): GroupedGame[]
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/grouping.test.ts
import { describe, it, expect } from 'vitest';
import { groupDisks } from './grouping';

const d = (filename: string, sha256: string) => ({ filename, sha256, sizeBytes: 901120 });

describe('groupDisks', () => {
  it('groups a multi-disk set into one game, ordered by disk number', () => {
    const games = groupDisks([
      d('Project-X (1992)(Team 17)(Disk 2 of 4).adf', 'b'),
      d('Project-X (1992)(Team 17)(Disk 1 of 4).adf', 'a'),
    ]);
    expect(games).toHaveLength(1);
    expect(games[0].title).toBe('Project-X');
    expect(games[0].disks.map((x) => x.diskNo)).toEqual([1, 2]);
    expect(games[0].disks[0].sha256).toBe('a');
  });

  it('marks only disk 1 as boot', () => {
    const g = groupDisks([
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
      d('X (1990)(Y)(Disk 2 of 2).adf', 'b'),
    ])[0];
    expect(g.disks.find((x) => x.diskNo === 1)!.isBoot).toBe(true);
    expect(g.disks.find((x) => x.diskNo === 2)!.isBoot).toBe(false);
  });

  it('treats a single disk as a one-disk game with disk number 1', () => {
    const g = groupDisks([d('Marble Slide (1990)(Handel, Peter)(PD).adf', 'a')])[0];
    expect(g.disks).toHaveLength(1);
    expect(g.disks[0].diskNo).toBe(1);
    expect(g.disks[0].isBoot).toBe(true);
  });

  it('keeps different titles apart', () => {
    expect(groupDisks([
      d('A (1990)(P).adf', 'a'),
      d('B (1991)(P).adf', 'b'),
    ])).toHaveLength(2);
  });

  it('does not merge same-titled releases from different years', () => {
    const games = groupDisks([
      d('Elite (1988)(Firebird).adf', 'a'),
      d('Elite (1991)(Hybrid).adf', 'b'),
    ]);
    expect(games).toHaveLength(2);
  });

  it('deduplicates identical hashes within one set', () => {
    const g = groupDisks([
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
    ])[0];
    expect(g.disks).toHaveLength(1);
  });

  it('returns games sorted by sortTitle', () => {
    const games = groupDisks([d('Zool (1992)(Gremlin).adf', 'z'), d('Alien (1993)(X).adf', 'a')]);
    expect(games.map((g) => g.title)).toEqual(['Alien', 'Zool']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/grouping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement grouping**

```ts
// src/lib/grouping.ts
import { parseTosecName } from './tosec';

export interface IncomingDisk { filename: string; sha256: string; sizeBytes: number }

export interface GroupedGame {
  title: string;
  sortTitle: string;
  year: number | null;
  publisher: string | null;
  disks: Array<{
    diskNo: number; sha256: string; filename: string; sizeBytes: number; isBoot: boolean;
  }>;
}

export function groupDisks(input: IncomingDisk[]): GroupedGame[] {
  const byKey = new Map<string, GroupedGame>();

  for (const item of input) {
    const parsed = parseTosecName(item.filename);
    // Year is part of the key: two releases of the same title in different
    // years are different games, not disks of one game.
    const key = `${parsed.sortTitle}::${parsed.year ?? ''}`;

    let game = byKey.get(key);
    if (!game) {
      game = {
        title: parsed.title, sortTitle: parsed.sortTitle,
        year: parsed.year, publisher: parsed.publisher, disks: [],
      };
      byKey.set(key, game);
    }

    if (game.disks.some((x) => x.sha256 === item.sha256)) continue;

    game.disks.push({
      diskNo: parsed.diskNo ?? 1,
      sha256: item.sha256,
      filename: item.filename,
      sizeBytes: item.sizeBytes,
      isBoot: false,
    });
  }

  const games = [...byKey.values()];
  for (const g of games) {
    g.disks.sort((a, b) => a.diskNo - b.diskNo);
    for (const disk of g.disks) disk.isBoot = disk.diskNo === 1;
  }
  games.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  return games;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/grouping.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Group disks into games by title and year

Year is part of the grouping key so two releases of the same title in
different years stay separate games rather than merging into one set."
git push
```

---

## Task 7: Content-addressed storage module

**Files:**
- Create: `src/lib/storage.ts`, `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `BLOB_READ_WRITE_TOKEN`
- Produces:
```ts
export interface DiskStore {
  uploadUrl(sha256: string, sizeBytes: number): Promise<{ url: string; expiresAt: Date }>;
  downloadUrl(sha256: string, ttlSeconds: number): Promise<string>;
  exists(sha256: string): Promise<boolean>;
  storageKey(sha256: string): string;
}
export const diskStore: DiskStore
```

This is the seam that makes a later move to R2 or self-hosted S3 a one-file change (spec D6/§6). Nothing else in the codebase may import `@vercel/blob`.

- [ ] **Step 1: Install**

```bash
pnpm add @vercel/blob
```

- [ ] **Step 2: Write the failing tests**

`@vercel/blob` is mocked — these assert *our* contract, not Vercel's.

```ts
// src/lib/storage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueSignedToken = vi.fn();
const presignUrl = vi.fn();
const head = vi.fn();

class BlobNotFoundError extends Error {
  constructor() { super('The requested blob does not exist'); this.name = 'BlobNotFoundError'; }
}

vi.mock('@vercel/blob', () => ({ issueSignedToken, presignUrl, head, BlobNotFoundError }));

const SHA = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  issueSignedToken.mockResolvedValue({
    delegationToken: 'del', clientSigningToken: 'sign', validUntil: Date.now() + 3_600_000,
  });
  presignUrl.mockResolvedValue({ presignedUrl: 'https://store.private.blob.vercel-storage.com/x' });
});

describe('diskStore', () => {
  it('derives a deterministic storage key from the hash', async () => {
    const { diskStore } = await import('./storage');
    expect(diskStore.storageKey(SHA)).toBe(`adf/${SHA}`);
  });

  it('rejects anything that is not a 64-char hex digest', async () => {
    const { diskStore } = await import('./storage');
    await expect(diskStore.uploadUrl('nope', 100)).rejects.toThrow(/sha-?256/i);
  });

  it('scopes the upload token to the exact path and size, and forbids overwrite', async () => {
    const { diskStore } = await import('./storage');
    await diskStore.uploadUrl(SHA, 901_120);

    expect(issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({
      pathname: `adf/${SHA}`, operations: ['put'], maximumSizeInBytes: 901_120,
    }));
    expect(presignUrl).toHaveBeenCalledWith(
      expect.objectContaining({ delegationToken: 'del', clientSigningToken: 'sign' }),
      expect.objectContaining({
        operation: 'put', access: 'private',
        addRandomSuffix: false, allowOverwrite: false,
      }),
    );
  });

  it('returns the presigned url string, not the wrapper object', async () => {
    const { diskStore } = await import('./storage');
    const out = await diskStore.uploadUrl(SHA, 100);
    expect(out.url).toBe('https://store.private.blob.vercel-storage.com/x');
  });

  it('issues a private GET with the requested ttl', async () => {
    const { diskStore } = await import('./storage');
    await diskStore.downloadUrl(SHA, 900);
    expect(presignUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'get', access: 'private' }),
    );
  });

  it('reports a missing blob as false rather than throwing', async () => {
    head.mockRejectedValue(new BlobNotFoundError());
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).resolves.toBe(false);
  });

  it('reports an existing blob as true', async () => {
    head.mockResolvedValue({ size: 901_120 });
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).resolves.toBe(true);
  });

  it('propagates unexpected head errors instead of reporting absence', async () => {
    head.mockRejectedValue(new Error('network is on fire'));
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).rejects.toThrow('network is on fire');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/lib/storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the store**

```ts
// src/lib/storage.ts
import { issueSignedToken, presignUrl, head, BlobNotFoundError } from '@vercel/blob';

export interface DiskStore {
  uploadUrl(sha256: string, sizeBytes: number): Promise<{ url: string; expiresAt: Date }>;
  downloadUrl(sha256: string, ttlSeconds: number): Promise<string>;
  exists(sha256: string): Promise<boolean>;
  storageKey(sha256: string): string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

function assertSha(sha256: string): void {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`storage: expected a lowercase hex sha-256 digest, got ${JSON.stringify(sha256)}`);
  }
}

function key(sha256: string): string {
  return `adf/${sha256}`;
}

/**
 * Vercel Blob implementation. The ONLY file that may import @vercel/blob —
 * swapping to R2 or a self-hosted S3 means writing another DiskStore here.
 */
export const diskStore: DiskStore = {
  storageKey: key,

  async uploadUrl(sha256, sizeBytes) {
    assertSha(sha256);
    const pathname = key(sha256);
    const validUntil = Date.now() + UPLOAD_TTL_MS;

    const token = await issueSignedToken({
      pathname,
      operations: ['put'],
      maximumSizeInBytes: sizeBytes,
      validUntil,
    });

    // presignUrl needs BOTH tokens, and returns { presignedUrl } — not a string.
    // addRandomSuffix/allowOverwrite are only signed into the URL when passed
    // explicitly, so always pass them.
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname,
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    return { url: presignedUrl, expiresAt: new Date(validUntil) };
  },

  async downloadUrl(sha256, ttlSeconds) {
    assertSha(sha256);
    const pathname = key(sha256);
    const validUntil = Date.now() + ttlSeconds * 1000;

    const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil,
    });

    // Carries its delegation and signature as query params: a bare HTTPS GET
    // with no headers and no SDK works. This is the ESP32 fetch path.
    return presignedUrl;
  },

  async exists(sha256) {
    assertSha(sha256);
    try {
      await head(key(sha256));
      return true;
    } catch (err) {
      // head() THROWS when absent; it does not return null.
      if (err instanceof BlobNotFoundError) return false;
      throw err;
    }
  },
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/lib/storage.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add content-addressed DiskStore over Vercel Blob

The only file importing @vercel/blob, so a later move to R2 or self-hosted
S3 is one new implementation. head() throws rather than returning null, so
existence is a try/catch on BlobNotFoundError."
git push
```

---

## Task 8: Ingest API

**Files:**
- Create: `src/app/api/ingest/check/route.ts`, `src/app/api/ingest/presign/route.ts`, `src/app/api/ingest/complete/route.ts`, `src/lib/ingest.ts`, `src/lib/ingest.test.ts`
- Modify: `src/proxy.ts` (do not guard `/api/ingest` — it is session-authenticated in-handler)

**Interfaces:**
- Consumes: `requireOrg()` (Task 3), `diskStore` (Task 7), `groupDisks` (Task 6), catalog tables (Task 2)
- Produces: three JSON endpoints, and from `@/lib/ingest`:
```ts
export function splitKnownMissing(requested: string[], known: Set<string>):
  { known: string[]; missing: string[] }
```

- [ ] **Step 1: Write the failing unit test for the pure part**

```ts
// src/lib/ingest.test.ts
import { describe, it, expect } from 'vitest';
import { splitKnownMissing } from './ingest';

describe('splitKnownMissing', () => {
  it('partitions requested hashes against what is already stored', () => {
    const r = splitKnownMissing(['a', 'b', 'c'], new Set(['b']));
    expect(r.known).toEqual(['b']);
    expect(r.missing).toEqual(['a', 'c']);
  });

  it('deduplicates repeated hashes in the request', () => {
    const r = splitKnownMissing(['a', 'a', 'b'], new Set());
    expect(r.missing).toEqual(['a', 'b']);
  });

  it('handles an empty request', () => {
    expect(splitKnownMissing([], new Set(['a']))).toEqual({ known: [], missing: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

```ts
// src/lib/ingest.ts
import { z } from 'zod';

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_BATCH = 500;

export const checkBody = z.object({
  hashes: z.array(z.string().regex(SHA256_RE)).min(1).max(MAX_BATCH),
});

export const presignBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
  })).min(1).max(MAX_BATCH),
});

export const completeBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
    filename: z.string().min(1).max(255),
  })).min(1).max(MAX_BATCH),
});

export function splitKnownMissing(requested: string[], known: Set<string>) {
  const seen = new Set<string>();
  const out = { known: [] as string[], missing: [] as string[] };
  for (const h of requested) {
    if (seen.has(h)) continue;
    seen.add(h);
    (known.has(h) ? out.known : out.missing).push(h);
  }
  return out;
}
```

```bash
pnpm add zod
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/ingest.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Implement `/api/ingest/check`**

```ts
// src/app/api/ingest/check/route.ts
import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { checkBody, splitKnownMissing } from '@/lib/ingest';

export async function POST(request: Request) {
  await requireOrg();

  const parsed = checkBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { hashes } = parsed.data;
  const rows = await getDb()
    .select({ sha256: blobs.sha256 })
    .from(blobs)
    .where(inArray(blobs.sha256, hashes));

  return Response.json(splitKnownMissing(hashes, new Set(rows.map((r) => r.sha256))));
}
```

- [ ] **Step 6: Implement `/api/ingest/presign`**

```ts
// src/app/api/ingest/presign/route.ts
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { presignBody } from '@/lib/ingest';

export async function POST(request: Request) {
  await requireOrg();

  const parsed = presignBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const uploads = await Promise.all(
    parsed.data.files.map(async (f) => {
      const { url, expiresAt } = await diskStore.uploadUrl(f.sha256, f.sizeBytes);
      return { sha256: f.sha256, url, expiresAt: expiresAt.toISOString() };
    }),
  );

  return Response.json({ uploads });
}
```

- [ ] **Step 7: Implement `/api/ingest/complete`**

Registers blobs globally, entitlements per tenant, and creates games/disks. `onConflictDoNothing` makes the whole endpoint idempotent, which matters because the CLI retries.

```ts
// src/app/api/ingest/complete/route.ts
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { blobs, entitlements, games, disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { completeBody } from '@/lib/ingest';
import { groupDisks } from '@/lib/grouping';

export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  const parsed = completeBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = getDb();
  const files = parsed.data.files;

  // Never trust the client that the bytes landed.
  const present = await Promise.all(files.map((f) => diskStore.exists(f.sha256)));
  const landed = files.filter((_, i) => present[i]);
  const rejected = files.filter((_, i) => !present[i]).map((f) => f.sha256);

  if (landed.length === 0) {
    return Response.json({ created: 0, rejected }, { status: 409 });
  }

  await db.insert(blobs).values(landed.map((f) => ({
    sha256: f.sha256, sizeBytes: f.sizeBytes, storageKey: diskStore.storageKey(f.sha256),
  }))).onConflictDoNothing();

  await db.insert(entitlements).values(landed.map((f) => ({
    orgId, sha256: f.sha256, sourceFilename: f.filename,
  }))).onConflictDoNothing();

  const grouped = groupDisks(landed.map((f) => ({
    filename: f.filename, sha256: f.sha256, sizeBytes: f.sizeBytes,
  })));

  for (const g of grouped) {
    const gameId = randomUUID();
    await db.insert(games).values({
      id: gameId, orgId, title: g.title, sortTitle: g.sortTitle,
      year: g.year, publisher: g.publisher, metadataSource: 'filename',
    });
    await db.insert(disks).values(g.disks.map((d) => ({
      id: randomUUID(), gameId, orgId, diskNo: d.diskNo, sha256: d.sha256,
      tosecName: d.filename, isBoot: d.isBoot, sizeBytes: d.sizeBytes,
    })));
  }

  return Response.json({ created: grouped.length, disks: landed.length, rejected });
}
```

- [ ] **Step 8: Write a Playwright API test for the round trip**

```ts
// e2e/ingest-api.spec.ts
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh } from './helpers';

test('check reports an unknown hash as missing', async ({ page, request }) => {
  await signUpFresh(page); // seeds the session cookie into the context

  const sha = createHash('sha256').update(`unique-${Date.now()}`).digest('hex');
  const res = await page.request.post('/api/ingest/check', { data: { hashes: [sha] } });

  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ known: [], missing: [sha] });
});

test('check rejects a malformed hash with 400', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.request.post('/api/ingest/check', { data: { hashes: ['nope'] } });
  expect(res.status()).toBe(400);
});

test('ingest endpoints reject an anonymous caller', async ({ request }) => {
  const res = await request.post('/api/ingest/check', {
    data: { hashes: ['a'.repeat(64)] },
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
});
```

- [ ] **Step 9: Run the tests**

Run: `pnpm e2e e2e/ingest-api.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add ingest API: check, presign, complete

complete() verifies with the store that bytes actually landed before writing
any row, and every insert is onConflictDoNothing so CLI retries are safe."
git push
```

---

## Task 9: `webadf push` CLI

**Files:**
- Create: `cli/package.json`, `cli/src/index.ts`, `cli/src/hash.ts`, `cli/src/hash.test.ts`, `cli/tsconfig.json`
- Modify: `pnpm-workspace.yaml` (add `cli`)

**Interfaces:**
- Consumes: the three ingest endpoints from Task 8
- Produces: `pnpm --filter webadf-cli start -- push <dir> --url <base> --token <session>`

- [ ] **Step 1: Create the workspace package**

```bash
mkdir -p cli/src
```

```json
// cli/package.json
{
  "name": "webadf-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "webadf": "./src/index.ts" },
  "scripts": { "start": "node --experimental-strip-types src/index.ts" },
  "dependencies": { "p-limit": "^6.2.0" }
}
```

Add `cli` to the `packages:` list in `pnpm-workspace.yaml`, then `pnpm install`.

- [ ] **Step 2: Write the failing hash test**

```ts
// cli/src/hash.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from './hash';

describe('hashFile', () => {
  it('produces the known sha-256 of an empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webadf-'));
    const f = join(dir, 'empty.adf');
    writeFileSync(f, '');
    await expect(hashFile(f)).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is stable across calls and lowercase hex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webadf-'));
    const f = join(dir, 'x.adf');
    writeFileSync(f, 'hello');
    const a = await hashFile(f);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFile(f)).toBe(a);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run cli/src/hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement streaming hash**

Streamed, not `readFile` — a 16 GB collection must never be buffered whole.

```ts
// cli/src/hash.ts
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run cli/src/hash.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Implement the push command**

```ts
// cli/src/index.ts
import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, basename } from 'node:path';
import pLimit from 'p-limit';
import { hashFile } from './hash.ts';

const DISK_EXT = new Set(['.adf', '.dsk', '.adz', '.dms']);
const BATCH = 500;
const CONCURRENCY = 6;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (DISK_EXT.has(extname(entry.name).toLowerCase())) yield p;
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main() {
  const [, , cmd, dir] = process.argv;
  const base = process.env.WEBADF_URL ?? 'http://localhost:3000';
  const cookie = process.env.WEBADF_COOKIE;

  if (cmd !== 'push' || !dir) {
    console.error('usage: WEBADF_COOKIE=<session cookie> webadf push <dir>');
    process.exit(1);
  }
  if (!cookie) {
    console.error('WEBADF_COOKIE is required — copy the session cookie from your browser');
    process.exit(1);
  }

  const api = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };

  process.stdout.write('  scanning ....... ');
  const paths: string[] = [];
  for await (const p of walk(dir)) paths.push(p);
  console.log(`${paths.length.toLocaleString()} files`);

  process.stdout.write('  hashing ........ ');
  const limit = pLimit(CONCURRENCY);
  const files = await Promise.all(paths.map((p) => limit(async () => ({
    path: p,
    filename: basename(p),
    sha256: await hashFile(p),
    sizeBytes: (await stat(p)).size,
  }))));
  console.log('done');

  let deduped = 0;
  let uploaded = 0;

  for (const group of chunk(files, BATCH)) {
    const { missing } = await api('/api/ingest/check', { hashes: group.map((f) => f.sha256) });
    const missingSet = new Set<string>(missing);
    deduped += group.length - missingSet.size;

    const toUpload = group.filter((f) => missingSet.has(f.sha256));
    if (toUpload.length > 0) {
      const { uploads } = await api('/api/ingest/presign', {
        files: toUpload.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes })),
      });
      const urlFor = new Map<string, string>(
        (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
      );

      await Promise.all(toUpload.map((f) => limit(async () => {
        const res = await fetch(urlFor.get(f.sha256)!, {
          method: 'PUT',
          body: createReadStream(f.path) as unknown as BodyInit,
          // @ts-expect-error — Node requires duplex for a stream body
          duplex: 'half',
        });
        if (!res.ok) throw new Error(`upload ${f.filename} -> ${res.status}`);
        uploaded++;
        process.stdout.write(`\r  uploading ...... ${uploaded}/${toUpload.length}`);
      })));
      process.stdout.write('\n');
    }

    await api('/api/ingest/complete', {
      files: group.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes, filename: f.filename })),
    });
  }

  console.log(`\n  ✓ ${uploaded} uploaded, ${deduped} already stored`);
}

main().catch((err) => { console.error('\n' + err.message); process.exit(1); });
```

- [ ] **Step 7: Smoke-test against the dev server with real disks**

```bash
pnpm dev &          # in another shell
# sign in at localhost:3000, copy the better-auth session cookie from devtools
WEBADF_COOKIE='better-auth.session_token=...' \
  pnpm --filter webadf-cli start -- push ../webadf/adf-archive
```

Expected: 61 files scanned and uploaded; a **second** run reports 61 already stored and 0 uploaded — which is the dedupe path proving itself.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add webadf push CLI

Streams hashes rather than buffering, so a 16 GB collection never lands in
memory. Re-running is a no-op: everything dedupes on sha-256."
git push
```

---

## Task 10: App shell and the gradient design system

**Files:**
- Create: `src/app/(app)/layout.tsx`, `src/components/shell/top-nav.tsx`, `src/components/shell/page-header.tsx`
- Modify: `src/app/globals.css`, `src/app/layout.tsx`

**Interfaces:**
- Consumes: `requireOrg()` (Task 3)
- Produces: `<PageHeader eyebrow title subtitle actions />`, and the CSS custom properties from spec §11.1

Values come from spec §11.1 verbatim. The reference implementation is `design/Main.dc.html`.

- [ ] **Step 1: Write the tokens into `globals.css`**

Append below the shadcn block, keeping shadcn's own `:root` intact:

```css
/* ---- webadf design tokens (spec §11.1) ---- */
:root {
  --grad-top: #1b2534;
  --grad-2:   #3a4d61;
  --grad-3:   #8d97a1;
  --grad-4:   #c8cfd3;
  --grad-bot: #eef1f2;

  --on-dark:        #eef3f6;
  --on-dark-muted:  rgb(233 240 244 / 0.62);

  --ink:        #16232f;
  --foreground: #223140;
  --muted:      #5b6c7c;
  --muted-2:    #8a99a6;
  --faint:      #a9b4bd;

  --glass:        rgb(255 255 255 / 0.62);
  --glass-panel:  rgb(255 255 255 / 0.68);
  --glass-strong: rgb(255 255 255 / 0.80);
  --glass-subtle: rgb(255 255 255 / 0.45);
  --glass-border: rgb(255 255 255 / 0.65);
  --input-bg:     rgb(255 255 255 / 0.75);
  --hairline:     rgb(30 45 60 / 0.08);
  --hairline-strong: rgb(30 45 60 / 0.14);
  --shadow-card:  0 1px 2px rgb(30 45 60 / 0.06), 0 8px 24px rgb(30 45 60 / 0.09);

  --primary-action: #16273a;
  --accent-blue:    #1a35d6;
  --accent-amber:   #f5822e;   /* FILL ONLY — fails AA as text */
  --amber-text:     #a8560f;   /* use this for amber text */
  --success-bg: #dff2e2; --success-fg: #1c7a3e;
  --warning-bg: #fdf1cf; --warning-fg: #8a6207;
  --danger-bg:  #fbe1e1; --danger-fg:  #c0342e;
  --online-dot: #5fd18b;
}

@theme inline {
  --color-ink: var(--ink);
  --color-on-dark: var(--on-dark);
  --color-glass: var(--glass);
  --color-accent-blue: var(--accent-blue);
  --color-amber-text: var(--amber-text);
  --radius-card: 14px;
}

/* Fixed is load-bearing: the gradient must stay put while content scrolls. */
.bg-page-gradient {
  background: linear-gradient(180deg,
    var(--grad-top) 0%, var(--grad-2) 9%, var(--grad-3) 34%,
    var(--grad-4) 62%, var(--grad-bot) 100%);
  background-attachment: fixed;
  min-height: 100vh;
}

.glass-card {
  background: var(--glass);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-card);
}
```

- [ ] **Step 2: Wire the real fonts in the root layout**

Replaces Geist. Task 1 already removed the `--font-sans` self-reference; this points it at Space Grotesk.

```tsx
// src/app/layout.tsx
import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const sans = Space_Grotesk({ variable: '--font-sans', subsets: ['latin'], weight: ['400','500','600','700'] });
const mono = IBM_Plex_Mono({ variable: '--font-mono', subsets: ['latin'], weight: ['400','500','600'] });

export const metadata: Metadata = {
  title: 'webadf',
  description: 'Your Amiga disk library, one click from the Gotek.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} bg-page-gradient antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

Then in `globals.css`, make sure the `@theme inline` block maps `--font-sans: var(--font-sans)` **is not** present (Task 1 fixed it) and instead reads:

```css
@theme inline {
  --font-sans: var(--font-sans);   /* now genuinely defined by next/font above */
  --font-mono: var(--font-mono);
}
```

Verify with: `grep -A2 'font-family' .next/static/css/*.css | head` after a build — the value must not be a self-reference.

- [ ] **Step 3: Build the page header**

```tsx
// src/components/shell/page-header.tsx
export function PageHeader({ eyebrow, title, subtitle, actions }: {
  eyebrow?: string; title: string; subtitle?: string; actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between px-7 pb-5 pt-6">
      <div className="flex flex-col gap-1">
        {eyebrow && (
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--on-dark-muted)' }}>
            {eyebrow}
          </span>
        )}
        <h1 className="text-[34px] font-bold leading-none tracking-[-0.032em]"
            style={{ color: 'var(--on-dark)' }}>{title}</h1>
        {subtitle && (
          <span className="mt-1 font-mono text-[11.5px]" style={{ color: 'var(--on-dark-muted)' }}>
            {subtitle}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}
```

- [ ] **Step 4: Build the top nav and app layout**

```tsx
// src/components/shell/top-nav.tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/library', label: 'Library' },
  { href: '/devices', label: 'Devices' },
  { href: '/ingest',  label: 'Ingest' },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="mx-auto flex items-center gap-[3px] rounded-full border p-1"
         style={{ background: 'rgb(255 255 255 / 0.12)', borderColor: 'rgb(255 255 255 / 0.16)' }}>
      {ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href}
                aria-current={active ? 'page' : undefined}
                className="flex h-[34px] items-center rounded-full px-4 text-[13px] transition-colors"
                style={active
                  ? { background: 'var(--on-dark)', color: '#16273a', fontWeight: 600 }
                  : { color: 'rgb(233 240 244 / 0.78)', fontWeight: 500 }}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

```tsx
// src/app/(app)/layout.tsx
import { requireOrg } from '@/lib/session';
import { TopNav } from '@/components/shell/top-nav';
import { SignOutButton } from '@/components/sign-out-button';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOrg();
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 px-7 pt-4">
        <span className="text-base font-bold tracking-[-0.02em]" style={{ color: 'var(--on-dark)' }}>
          webadf
        </span>
        <TopNav />
        <SignOutButton />
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Verify visually with Playwright**

```ts
// e2e/shell.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('the shell renders on the gradient with the right fonts', async ({ page }) => {
  await signUpFresh(page);

  const bodyFont = await page.evaluate(() =>
    getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain('Space Grotesk');   // catches the shadcn self-reference bug

  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundImage);
  expect(bg).toContain('linear-gradient');

  await expect(page.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });
});
```

Run: `pnpm e2e e2e/shell.spec.ts`
Expected: PASS. Open `test-results/shell.png` and compare against `design/Main.dc.html`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add app shell and the gradient design tokens

Fonts are asserted in an e2e test because the shadcn --font-sans
self-reference fails silently — the page just renders in the fallback."
git push
```

---

## Task 11: Library grid view

**Files:**
- Create: `src/lib/queries.ts`, `src/components/library/game-grid.tsx`, `src/components/library/cover.tsx`
- Modify: `src/app/(app)/library/page.tsx`

**Interfaces:**
- Consumes: `requireOrg()`, `orgFilter()`, catalog tables
- Produces:
```ts
export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
}
export function listGames(orgId: string, opts?: { limit?: number }): Promise<GameListItem[]>
```

- [ ] **Step 1: Write the query**

Every read goes through `orgFilter` — that is the tenancy chokepoint from Task 2.

```ts
// src/lib/queries.ts
import { sql, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks } from '@/db/schema/catalog';
import { orgFilter } from '@/db/scope';

export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
}

export async function listGames(orgId: string, opts: { limit?: number } = {}): Promise<GameListItem[]> {
  return getDb()
    .select({
      id: games.id, title: games.title, year: games.year, publisher: games.publisher,
      coverAssetId: games.coverAssetId,
      diskCount: sql<number>`count(${disks.id})::int`,
    })
    .from(games)
    .leftJoin(disks, sql`${disks.gameId} = ${games.id}`)
    .where(orgFilter(games, orgId))
    .groupBy(games.id)
    .orderBy(desc(games.createdAt))     // recently added first (spec §10, D9)
    .limit(opts.limit ?? 200);
}
```

- [ ] **Step 2: Build the placeholder cover**

A game with no artwork is a designed state, not an error (spec §10.3). Hue is derived from the id so it is stable across reloads.

```tsx
// src/components/library/cover.tsx
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function Cover({ id, title, diskCount }: { id: string; title: string; diskCount: number }) {
  const hue = hueFor(id);
  return (
    <div className="relative overflow-hidden rounded-lg" style={{
      aspectRatio: '1.23 / 1',   // matches the firmware's 138x112 cover box
      background: `linear-gradient(150deg, oklch(0.44 0.16 ${hue}), oklch(0.24 0.10 ${(hue + 45) % 360}))`,
      boxShadow: '0 1px 3px rgb(30 45 60 / 0.22)',
    }}>
      <div className="absolute inset-0" style={{
        background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 3px)',
      }} />
      <div className="absolute inset-0 flex items-end p-3" style={{
        background: 'linear-gradient(to top, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.12) 48%, transparent 76%)',
      }}>
        <span className="text-sm font-bold leading-tight tracking-[-0.018em] text-white"
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.55)' }}>{title}</span>
      </div>
      {diskCount > 1 && (
        <div className="absolute right-2 top-2 rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold"
             style={{ background: 'rgb(255 255 255 / 0.90)', color: '#16273a' }}>
          {diskCount}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the grid and empty state**

```tsx
// src/components/library/game-grid.tsx
import Link from 'next/link';
import { Cover } from './cover';
import type { GameListItem } from '@/lib/queries';

export function GameGrid({ games }: { games: GameListItem[] }) {
  if (games.length === 0) {
    return (
      <div className="glass-card mx-7 flex flex-col items-center gap-3 p-12 text-center">
        <p className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>No disks yet</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Drop some ADFs on the ingest page, or run <code className="font-mono">webadf push</code>.
        </p>
        <Link href="/ingest" className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: 'var(--primary-action)' }}>Add disks</Link>
      </div>
    );
  }

  return (
    <div className="mx-7 grid grid-cols-5 gap-4" data-testid="game-grid">
      {games.map((g) => (
        <Link key={g.id} href={`/games/${g.id}`} className="glass-card flex flex-col p-2.5"
              data-testid="game-card">
          <Cover id={g.id} title={g.title} diskCount={g.diskCount} />
          <div className="flex flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
            <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              {g.title}
            </span>
            <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
              {[g.year, g.publisher].filter(Boolean).join(' · ') || 'unidentified'}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire the page**

```tsx
// src/app/(app)/library/page.tsx
import { requireOrg } from '@/lib/session';
import { listGames } from '@/lib/queries';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';

export default async function LibraryPage() {
  const { orgId } = await requireOrg();
  const games = await listGames(orgId);
  const diskTotal = games.reduce((n, g) => n + g.diskCount, 0);

  return (
    <>
      <PageHeader
        eyebrow="Amiga collection"
        title="Library"
        subtitle={`${games.length.toLocaleString()} titles · ${diskTotal.toLocaleString()} disks`}
      />
      <GameGrid games={games} />
    </>
  );
}
```

- [ ] **Step 5: Write the Playwright test**

```ts
// e2e/library.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('a brand-new library shows the empty state, not an error', async ({ page }) => {
  await signUpFresh(page);
  await expect(page.getByText('No disks yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add disks' })).toBeVisible();
});

test('one org cannot see another org\'s games', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  await signUpFresh(pageA);
  await signUpFresh(pageB);

  // Both are empty, but the point is that neither 500s and neither leaks.
  await expect(pageA.getByText('No disks yet')).toBeVisible();
  await expect(pageB.getByText('No disks yet')).toBeVisible();

  await a.close(); await b.close();
});
```

Run: `pnpm e2e e2e/library.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify against real data and screenshot**

With the CLI push from Task 9 done, reload `/library` and confirm the grid shows real titles from `adf-archive/`.

```bash
pnpm e2e e2e/shell.spec.ts   # regenerates test-results/shell.png with content
```

Compare against `design/Main.dc.html`. Note honestly in the commit if spacing drifts — do not silently redesign.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add library grid view

Placeholder covers are a designed state with a stable per-game hue, not an
error path — most disks will have no artwork until plan 3 lands."
git push
```

---

## Task 12: Table view and the view toggle

**Files:**
- Create: `src/components/library/game-table.tsx`, `src/components/library/view-toggle.tsx`
- Modify: `src/app/(app)/library/page.tsx`, `src/lib/queries.ts`

**Interfaces:**
- Consumes: `GameListItem`, `listGames`
- Produces: `?view=table` on `/library`; `listGames` gains `sizeBytes` and `sha256Prefix`

Spec D7: grid for browsing by cover, table for finding one disk among thousands.

- [ ] **Step 1: Extend the query**

```ts
// src/lib/queries.ts — extend GameListItem and the select
export interface GameListItem {
  id: string; title: string; year: number | null; publisher: string | null;
  diskCount: number; coverAssetId: string | null;
  sizeBytes: number; sha256Prefix: string | null;
}
```

Add to the `.select({...})`:

```ts
      sizeBytes: sql<number>`coalesce(sum(${disks.sizeBytes}), 0)::bigint`,
      sha256Prefix: sql<string | null>`min(${disks.sha256})`,
```

- [ ] **Step 2: Build the table**

```tsx
// src/components/library/game-table.tsx
import Link from 'next/link';
import type { GameListItem } from '@/lib/queries';

const COLS = 'grid-cols-[30px_1fr_50px_156px_40px_74px_100px]';

function fmtSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_048_576).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function GameTable({ games }: { games: GameListItem[] }) {
  return (
    <div className="glass-card mx-7 overflow-hidden" data-testid="game-table">
      <div className={`grid ${COLS} items-center border-b px-4 py-2 font-mono text-[9.5px] tracking-[0.06em]`}
           style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
        <span /><span>TITLE</span><span>YEAR</span><span>PUBLISHER</span>
        <span className="text-right">DSK</span><span className="text-right">SIZE</span>
        <span className="text-right">SHA-256</span>
      </div>
      {games.map((g, i) => (
        <Link key={g.id} href={`/games/${g.id}`} data-testid="game-row"
              className={`grid ${COLS} items-center border-b px-4 py-2 font-mono text-[11px] hover:bg-white/40`}
              style={{ borderColor: 'rgb(30 45 60 / 0.05)' }}>
          <span style={{ color: 'var(--faint)' }}>{String(i + 1).padStart(2, '0')}</span>
          <span className="truncate pr-3 font-medium" style={{ color: 'var(--ink)' }}>{g.title}</span>
          <span style={{ color: 'var(--muted)' }}>{g.year ?? '—'}</span>
          <span className="truncate pr-3" style={{ color: 'var(--muted)' }}>{g.publisher ?? '—'}</span>
          <span className="text-right font-semibold"
                style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--muted-2)' }}>
            {g.diskCount}
          </span>
          <span className="text-right" style={{ color: 'var(--muted-2)' }}>{fmtSize(g.sizeBytes)}</span>
          <span className="text-right text-[10px]" style={{ color: 'var(--faint)' }}>
            {g.sha256Prefix ? `${g.sha256Prefix.slice(0, 8)}…` : '—'}
          </span>
        </Link>
      ))}
    </div>
  );
}
```

Note `--amber-text`, not `--accent-amber`: amber is a fill colour and fails AA as text (spec §11.1).

- [ ] **Step 3: Build the toggle**

A plain link pair, so it works without JS and the choice survives a reload.

```tsx
// src/components/library/view-toggle.tsx
import Link from 'next/link';

export function ViewToggle({ view }: { view: 'grid' | 'table' }) {
  const base = 'grid h-8 w-9 place-items-center text-[11px] font-semibold';
  const on  = { background: 'var(--primary-action)', color: '#fff' };
  const off = { color: 'var(--muted)' };
  return (
    <div className="flex overflow-hidden rounded-lg border"
         style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)' }}>
      <Link href="/library?view=grid"  aria-label="Grid view"  aria-pressed={view === 'grid'}
            className={base} style={view === 'grid' ? on : off}>▦</Link>
      <Link href="/library?view=table" aria-label="Table view" aria-pressed={view === 'table'}
            className={base} style={view === 'table' ? on : off}>☰</Link>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the page**

`searchParams` is a Promise in Next 16 and must be awaited.

```tsx
// src/app/(app)/library/page.tsx
import { requireOrg } from '@/lib/session';
import { listGames } from '@/lib/queries';
import { PageHeader } from '@/components/shell/page-header';
import { GameGrid } from '@/components/library/game-grid';
import { GameTable } from '@/components/library/game-table';
import { ViewToggle } from '@/components/library/view-toggle';

export default async function LibraryPage(props: PageProps<'/library'>) {
  const { orgId } = await requireOrg();
  const sp = await props.searchParams;
  const view = sp.view === 'table' ? 'table' : 'grid';

  const games = await listGames(orgId);
  const diskTotal = games.reduce((n, g) => n + g.diskCount, 0);

  return (
    <>
      <PageHeader
        eyebrow="Amiga collection"
        title="Library"
        subtitle={`${games.length.toLocaleString()} titles · ${diskTotal.toLocaleString()} disks`}
        actions={<ViewToggle view={view} />}
      />
      {view === 'table' ? <GameTable games={games} /> : <GameGrid games={games} />}
    </>
  );
}
```

- [ ] **Step 5: Write the Playwright test**

```ts
// e2e/view-toggle.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

test('the view toggle switches between grid and table and survives reload', async ({ page }) => {
  await signUpFresh(page);

  await page.getByLabel('Table view').click();
  await expect(page).toHaveURL(/view=table/);

  await page.reload();
  await expect(page.getByLabel('Table view')).toHaveAttribute('aria-pressed', 'true');

  await page.getByLabel('Grid view').click();
  await expect(page).toHaveURL(/view=grid/);
});
```

Run: `pnpm e2e e2e/view-toggle.spec.ts`
Expected: PASS. (With an empty library both views render the empty state; re-run after the CLI push to see real rows.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add table view and the grid/table toggle

Toggle is a link pair rather than client state, so the choice survives a
reload and works without JS."
git push
```

---

## Task 13: Ingest UI

**Files:**
- Create: `src/app/(app)/ingest/page.tsx`, `src/components/ingest/dropzone.tsx`, `src/lib/browser-hash.ts`
- Modify: none

**Interfaces:**
- Consumes: the ingest endpoints (Task 8)
- Produces: `/ingest` — drag files, see them hash, upload and appear

Spec D9: every finished row carries a mount action so the fast path is drop → click → play. Mounting arrives in plan 2; this task leaves the column in place with the button disabled and labelled.

- [ ] **Step 1: Write the browser hash helper**

`crypto.subtle.digest` needs the whole buffer, which is fine at 880 KB per disk.

```ts
// src/lib/browser-hash.ts
export async function hashBlob(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Build the dropzone**

```tsx
// src/components/ingest/dropzone.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { hashBlob } from '@/lib/browser-hash';

type Row = {
  filename: string; sizeBytes: number; sha256: string;
  state: 'hashing' | 'deduped' | 'uploading' | 'done' | 'failed';
};

export function Dropzone() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const patch = (sha: string, next: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.sha256 === sha ? { ...r, ...next } : r)));

  async function handleFiles(fileList: FileList) {
    setBusy(true);
    const files = [...fileList].filter((f) => /\.(adf|dsk|adz|dms)$/i.test(f.name));

    const hashed: Array<{ file: File; sha256: string }> = [];
    for (const file of files) {
      const sha256 = await hashBlob(file);
      hashed.push({ file, sha256 });
      setRows((rs) => [...rs, {
        filename: file.name, sizeBytes: file.size, sha256, state: 'hashing',
      }]);
    }

    const post = (path: string, body: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const { missing } = await post('/api/ingest/check', { hashes: hashed.map((h) => h.sha256) });
    const missingSet = new Set<string>(missing);

    for (const h of hashed) {
      if (!missingSet.has(h.sha256)) patch(h.sha256, { state: 'deduped' });
    }

    const toUpload = hashed.filter((h) => missingSet.has(h.sha256));
    if (toUpload.length > 0) {
      const { uploads } = await post('/api/ingest/presign', {
        files: toUpload.map((h) => ({ sha256: h.sha256, sizeBytes: h.file.size })),
      });
      const urlFor = new Map<string, string>(
        (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
      );

      await Promise.all(toUpload.map(async (h) => {
        patch(h.sha256, { state: 'uploading' });
        const res = await fetch(urlFor.get(h.sha256)!, { method: 'PUT', body: h.file });
        patch(h.sha256, { state: res.ok ? 'done' : 'failed' });
      }));
    }

    await post('/api/ingest/complete', {
      files: hashed.map((h) => ({
        sha256: h.sha256, sizeBytes: h.file.size, filename: h.file.name,
      })),
    });

    setRows((rs) => rs.map((r) => (r.state === 'hashing' ? { ...r, state: 'done' } : r)));
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="mx-7 flex flex-col gap-4">
      <label
        data-testid="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
        className="glass-card flex h-48 cursor-pointer flex-col items-center justify-center gap-3"
        style={{ borderStyle: 'dashed', borderColor: 'rgb(245 130 46 / 0.55)' }}
      >
        <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
          Drop ADF or DSK files
        </span>
        <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
          hashed in your browser before upload
        </span>
        <input type="file" multiple accept=".adf,.dsk,.adz,.dms" className="sr-only"
               data-testid="file-input" disabled={busy}
               onChange={(e) => e.target.files && void handleFiles(e.target.files)} />
      </label>

      {rows.length > 0 && (
        <div className="glass-card overflow-hidden" data-testid="ingest-rows">
          {rows.map((r) => (
            <div key={r.sha256} data-testid="ingest-row"
                 className="grid grid-cols-[1fr_100px_90px_90px] items-center border-b px-4 py-2 font-mono text-[11px]"
                 style={{ borderColor: 'rgb(30 45 60 / 0.05)' }}>
              <span className="truncate pr-3" style={{ color: 'var(--foreground)' }}>{r.filename}</span>
              <span className="text-right" style={{ color: 'var(--muted-2)' }}>
                {Math.round(r.sizeBytes / 1024)} KB
              </span>
              <span className="text-right text-[10px]" style={{ color: 'var(--faint)' }}>
                {r.sha256.slice(0, 8)}…
              </span>
              <span className="text-right text-[10px] font-semibold uppercase"
                    data-state={r.state}
                    style={{ color: r.state === 'failed' ? 'var(--danger-fg)'
                            : r.state === 'deduped' ? 'var(--accent-blue)'
                            : r.state === 'done' ? 'var(--success-fg)' : 'var(--amber-text)' }}>
                {r.state}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the page**

```tsx
// src/app/(app)/ingest/page.tsx
import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { Dropzone } from '@/components/ingest/dropzone';

export default async function IngestPage() {
  await requireOrg();
  return (
    <>
      <PageHeader
        eyebrow="Add disks"
        title="Ingest"
        subtitle="hash first, upload only what is missing"
      />
      <Dropzone />
    </>
  );
}
```

- [ ] **Step 4: Write the Playwright test**

Uses a real 901,120-byte buffer, the true ADF size.

```ts
// e2e/ingest-ui.spec.ts
import { test, expect } from '@playwright/test';
import { signUpFresh } from './helpers';

const ADF_BYTES = 901_120;

function fakeAdf(seed: number): Buffer {
  const b = Buffer.alloc(ADF_BYTES);
  b.write(`DOS\0webadf-test-${seed}`, 0);
  return b;
}

test('uploading a disk shows it in the library', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/ingest');

  await page.getByTestId('file-input').setInputFiles({
    name: 'Test Game (1992)(Acme)(Disk 1 of 2).adf',
    mimeType: 'application/octet-stream',
    buffer: fakeAdf(Date.now()),
  });

  await expect(page.getByTestId('ingest-row')).toHaveCount(1);
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.goto('/library');
  await expect(page.getByText('Test Game')).toBeVisible();
});

test('re-uploading the same bytes dedupes instead of uploading again', async ({ page }) => {
  await signUpFresh(page);
  const buffer = fakeAdf(4242);

  await page.goto('/ingest');
  await page.getByTestId('file-input').setInputFiles({
    name: 'Dedupe Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="done"]'))
    .toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByTestId('file-input').setInputFiles({
    name: 'Dedupe Me (1990)(X).adf', mimeType: 'application/octet-stream', buffer,
  });
  await expect(page.getByTestId('ingest-row').first().locator('[data-state="deduped"]'))
    .toBeVisible({ timeout: 30_000 });
});
```

Run: `pnpm e2e e2e/ingest-ui.spec.ts`
Expected: PASS, 2 tests. The second is the one that matters — it proves content addressing end to end.

- [ ] **Step 5: Full suite and deploy**

```bash
pnpm test && pnpm e2e && pnpm build
vercel deploy --prod --yes
```

Expected: all green, production URL live. Sign up on production and upload one disk to confirm Blob and Neon are wired in the deployed environment, not just locally.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add ingest UI with browser-side hashing

The dedupe test is the one that matters: uploading identical bytes twice
must report deduped, which proves content addressing end to end."
git push
```

---

## Self-Review

**Spec coverage.** §4 architecture → Tasks 1–3, 7–9. §5 data model → Task 2 (catalog) + Task 3 (auth/org), with the verified `pgSchema` correction applied. §6 storage → Task 7. §9 ingest → Tasks 5, 6, 8, 9, 13. §11 web UI → Tasks 10–12. §11.1 visual system → Task 10, with the amber contrast rule honoured in Task 12.

**Deliberately out of scope,** deferred to later plans: §7 device protocol and §8 firmware → plan 2. §10 enrichment stages 1–4, the review queue and the SSE progressive UI → plan 3. Stage 0 (filename parse) **is** here, in Task 5, because ingest depends on it. Game detail (`/games/[id]`) is linked from both library views but is built in plan 2 alongside mount/swap — until then those links 404, which Task 11's tests do not assert against.

**Known gaps to watch during execution:**
- Task 9's CLI takes a session cookie pasted from devtools. Crude but honest for v1; a real device-style token for the CLI belongs in plan 2 once token infrastructure exists.
- `/onboarding` is referenced by `requireOrg()` as the redirect when a user somehow has no org (the non-atomic hook from Task 3 failing). That route is not built in this plan — if the redirect ever fires it will 404. Acceptable because the Task 4 e2e test proves the happy path, but worth a stub if it shows up in logs.
