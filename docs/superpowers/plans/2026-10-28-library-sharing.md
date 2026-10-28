# Library Sharing (Remote libraries) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners share chosen collections with one person per claim-once link; recipients browse the library under
Remote, mount its disks on their own boards and send them over PaulaNET; the first Amiga write turns the copy into a
local Uncategorized disk.

**Architecture:** The owner's instance exposes a read-only, token-checked `/api/share/v1/*` API. The recipient's
server holds the token (encrypted), calls that API through a guarded HTTPS client (SSRF guard, optional pinned root,
no redirects) and proxies everything to its own pages. Mounting materialises a hidden `games` + `disks` row pair
(marked with `remote_library_id`), so mount, send, write-back and history run unchanged; `recordVersion` clears the
marks on the first write.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before writing routes/pages; params are
Promises), drizzle + node-postgres, vitest (`pnpm test`, `pnpm test:db`), Playwright e2e, Node 24 `node:https`.

**Spec:** `docs/superpowers/specs/2026-10-28-library-sharing-design.md` (read it before your task).

## Global Constraints

- One feature branch `feat/library-sharing`, in a worktree. Never `git add -A` (add named paths). Never `git stash`.
- Commit messages end with exactly one trailer line: `Claude-Session: https://claude.ai/code/session_01UC3JRhVLZ5t9XkU2Ekdf6j` (no Co-Authored-By).
- Migrations: `pnpm db:generate` then `pnpm db:migrate` against the LOCAL dev DB only (`pnpm db:dev start`, TEST_DATABASE_URL). Never `db:push`. NEVER run a migration against production; the controller does that before merge. Never read or print `.env.local` values.
- e2e: `PORT=3100`, one run at a time, foreground, each run under 9 minutes (split with `-g` if longer). e2e uses the live production DB through `.env.local`; prefer `bash scripts/e2e-local.sh e2e/<spec>.ts` (own Postgres) for new specs.
- Never pattern-kill processes; stop only PIDs you started.
- Not-found and other-org/out-of-scope are indistinguishable: always 404 `{error:'not_found'}`.
- Byte routes: `export const maxDuration = 60`. Disk bytes never exceed `MAX_DISK_BYTES` (2,621,440, `src/lib/blob-upload.ts`).
- Client components never import a module that reaches `@/db` (`src/lib/client-bundle-boundary.test.ts`).
- Protocol constant `SHARE_PROTOCOL = 1`; header `X-WebFloppy-Share-Protocol: 1` on every share API response.
- Claim code expiry 7 days. Codes/tokens: 32 random bytes base64url, prefixed `wfsc_` (code) and `wfst_` (token); stored as sha256 hex.
- Rate limits per token: listings 120/min, bytes 30/min; claim 10/min per client IP.
- Listing cache on the recipient: 60 s per (remote library, request).
- Outbound limits: listings 2 MB / 10 s; bytes `MAX_DISK_BYTES` / 60 s. Redirects refused.
- `WEBADF_SHARE_PRIVATE_ADDRESSES`: unset = hosted default (private refused); self-host `applyAppEnv` defaults it to `1`; `0` refuses. `WEBADF_SHARE_TEST_INSECURE=1` (test-only) additionally allows `http:` and loopback; set only by the e2e web server.
- UI copy is plain English: "Access ended", "Can't reach <host>", "This link was already used, has expired or was revoked", "<host> needs a WebFloppy update" / "Your WebFloppy needs an update", "Remote · <name>".

## Review Focus

1. A title removed from a shared collection after a recipient cached its listing: the owner must 404 its disk bytes and the recipient's Mount must fail with "no longer shared", never mount stale bytes. (Task 3, Task 7 tests.)
2. A hidden remote title/disk leaking into ANY local view (library, Uncategorized, search, counts, collections, NFC disk list, demozoo queue, next-disk, admin counts, live state). (Task 6 test enumerates each query.)
3. A revoked share while a hidden disk sits in DF0/DF1: the recipient must eject before deleting; the board must not keep serving a disk whose row is gone. (Task 8 test.)
4. A link pasted with surrounding whitespace, a trailing slash, the landing-page URL instead of the claim link, or `#link=` percent-encoded: Add must accept all of them. (Task 5 test.)
5. Two recipients' instances racing the same claim code: exactly one wins; the other gets the one-answer 404. (Task 2 test.)

---

### Task 1: Schema and migration 0050

**Files:**
- Create: `src/db/schema/sharing.ts`
- Modify: `src/db/schema/catalog.ts` (games, disks: two nullable columns each), `src/db/index.ts` (import + spread `sharing`)
- Create: `drizzle/0050_library_sharing.sql` (+ meta via `pnpm db:generate`; rename the generated file to this name and fix the journal tag, as `0025_nfc_tap` was)
- Test: `src/db/schema/sharing.db.test.ts`

**Interfaces — Produces:** tables `libraryShares`, `libraryShareCollections`, `remoteLibraries`; columns `games.remoteLibraryId`, `games.remoteTitleId`, `disks.remoteLibraryId`, `disks.remoteDiskId`.

- [ ] **Step 1: Write the schema**

```ts
// src/db/schema/sharing.ts
import { pgTable, text, boolean, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { collections } from './collections';

/** Owner side (spec §3.1): one row per person a library is shared with. Codes/tokens stored as sha256 hex only. */
export const libraryShares = pgTable('library_shares', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  label: text('label').notNull(),
  everything: boolean('everything').notNull().default(false),
  claimCodeHash: text('claim_code_hash'),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }).notNull(),
  tokenHash: text('token_hash'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedByUrl: text('claimed_by_url'),
  claimedByName: text('claimed_by_name'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
}, (t) => [
  index('library_shares_org_idx').on(t.orgId),
  uniqueIndex('library_shares_code_idx').on(t.claimCodeHash),
  uniqueIndex('library_shares_token_idx').on(t.tokenHash),
]);

export const libraryShareCollections = pgTable('library_share_collections', {
  shareId: text('share_id').notNull().references(() => libraryShares.id, { onDelete: 'cascade' }),
  collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.shareId, t.collectionId] }), index('library_share_collections_coll_idx').on(t.collectionId)]);

/** Recipient side (spec §4.1). token_enc: AES-256-GCM, key HKDF(BETTER_AUTH_SECRET, 'webadf-share-token'). */
export const remoteLibraries = pgTable('remote_libraries', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  baseUrl: text('base_url').notNull(),
  tokenEnc: text('token_enc').notNull(),
  tlsPin: text('tls_pin'),
  name: text('name').notNull(),
  status: text('status').notNull().default('ok'),   // 'ok' | 'unreachable' | 'ended' | 'protocol'
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastError: text('last_error'),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  addedBy: text('added_by').notNull(),
}, (t) => [index('remote_libraries_org_idx').on(t.orgId)]);
```

In `catalog.ts` add to `games`: `remoteLibraryId: text('remote_library_id').references(() => remoteLibraries.id)` and
`remoteTitleId: text('remote_title_id')`; to `disks`: `remoteLibraryId: text('remote_library_id').references(() =>
remoteLibraries.id)` and `remoteDiskId: text('remote_disk_id')`, plus `index('disks_remote_idx').on(t.remoteLibraryId,
t.remoteDiskId)`. No cascade: removal is explicit (Task 8). Import `remoteLibraries` lazily from `./sharing` (check for a
circular import with `collections.ts`; if drizzle complains, declare the FK in SQL only and leave the column plain).

- [ ] **Step 2: Generate and apply locally**

Run: `pnpm db:dev start && pnpm db:generate && pnpm db:migrate` (local DB only). Expected: `drizzle/0050_*.sql`
creating three tables, four columns, indexes. Rename to `0050_library_sharing.sql`, update `_journal.json` tag.

- [ ] **Step 3: DB test** — insert a share with two collections; delete one collection → its join row is gone;
delete the share → join rows gone; insert a remote library and a games/disks pair pointing at it. Run
`pnpm test:db src/db/schema/sharing.db.test.ts`. Expected PASS.

- [ ] **Step 4: Commit** `git add src/db/schema/sharing.ts src/db/schema/catalog.ts src/db/index.ts drizzle/0050_library_sharing.sql drizzle/meta src/db/schema/sharing.db.test.ts`

---

### Task 2: Owner share store (create, claim, authenticate, scope, revoke)

**Files:**
- Create: `src/lib/share/tokens.ts`, `src/lib/share/store.ts`, `src/lib/share/scope.ts`
- Test: `src/lib/share/tokens.test.ts`, `src/lib/share/store.db.test.ts`, `src/lib/share/scope.db.test.ts`

**Interfaces — Produces:**
```ts
// tokens.ts (pure)
export const SHARE_PROTOCOL = 1;
export function mintClaimCode(): { plaintext: string; hash: string }   // 'wfsc_' + 32B base64url
export function mintShareToken(): { plaintext: string; hash: string }  // 'wfst_' + 32B base64url
export function hashSecret(plaintext: string): string                  // sha256 hex
// store.ts
export type ShareRow = { id; label; everything; collectionIds: string[]; status: 'waiting'|'expired'|'claimed'|'revoked';
  claimExpiresAt; claimedAt; claimedByUrl; claimedByName; lastUsedAt; createdAt };
export async function createShare(orgId, userId, input: { label: string; everything: boolean; collectionIds: string[] })
  : Promise<{ ok: true; share: ShareRow; code: string } | { ok: false; reason: 'bad_label'|'no_scope'|'bad_collection' }>
export async function listShares(orgId): Promise<ShareRow[]>
export async function updateShareScope(orgId, shareId, input: { everything: boolean; collectionIds: string[] }): Promise<boolean>
export async function revokeShare(orgId, shareId): Promise<boolean>
export async function deleteShare(orgId, shareId): Promise<boolean>      // only revoked or expired rows
export async function claimShare(code: string, claimant: { url: string; name: string }, now?: Date)
  : Promise<{ ok: true; token: string; orgId: string; shareId: string } | { ok: false }>
export type ShareAuth = { shareId: string; orgId: string; everything: boolean };
export async function authenticateShare(bearer: string | null, now?: Date): Promise<ShareAuth | null>  // also bumps last_used_at at most once a minute
// scope.ts
export async function scopedCollectionIds(auth: ShareAuth): Promise<string[]>          // everything → all org collections
export async function titleInScope(auth: ShareAuth, gameId: string): Promise<boolean>
export async function diskInScope(auth: ShareAuth, diskId: string): Promise<{ sha256: string; sizeBytes: number; gameId: string } | null>
```

Rules:
- `createShare`: label trimmed 1-60 chars; `everything` or ≥1 collection id, each belonging to `orgId` (else `bad_collection`); `claimExpiresAt = now + 7 days`; ids via `randomUUID()`.
- `claimShare`: one atomic `UPDATE library_shares SET claim_code_hash = NULL, token_hash = $tok, claimed_at = now, claimed_by_url, claimed_by_name WHERE claim_code_hash = $hash AND revoked_at IS NULL AND claim_expires_at > now RETURNING id, org_id` (copy `claimInvite` in `src/lib/invites.ts:97`). Any miss → `{ok:false}`.
- `authenticateShare`: parse `/^Bearer\s+(wfst_\S+)$/i`, look up by hash, compare with `tokensMatch` (`src/lib/device-token.ts`), reject revoked.
- Scope: only titles/disks of `auth.orgId` with `games.remote_library_id IS NULL` (never re-share someone else's hidden copy), and (`everything` or `EXISTS collection_games cg JOIN library_share_collections lsc ON lsc.collection_id = cg.collection_id WHERE lsc.share_id = $id AND cg.game_id = games.id`).

- [ ] **Step 1: Failing tests.** tokens: prefixes, 32-byte entropy (decoded length), hash is 64 hex, distinct per call. store (db): create → listShares status `waiting`; claim → `claimed` with url/name and a token that `authenticateShare` accepts; second claim with same code → `{ok:false}`; **two concurrent `claimShare` calls with one code (Promise.all) → exactly one ok** (Review Focus 5); expired code (now = +8 days) → `{ok:false}` and status `expired`; revoke → `authenticateShare` null and status `revoked`; `deleteShare` refuses a claimed active share; label '' and 61 chars → `bad_label`; foreign collection → `bad_collection`. scope (db): title in a shared collection true; title in an unshared one false; after `DELETE FROM collection_games` for it → false (Review Focus 1); `everything` true for all local titles; a hidden remote title (games.remote_library_id set) false even with everything; another org's title false.
- [ ] **Step 2: Run** `pnpm test src/lib/share/tokens.test.ts && pnpm test:db src/lib/share` — Expected FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules per the rules above.
- [ ] **Step 4: Run** the same — Expected PASS.
- [ ] **Step 5: Commit** the named files.

---

### Task 3: Share API routes (owner's instance)

**Files:**
- Create: `src/lib/share/api.ts` (shared response helpers + rate limits), `src/lib/share/listing.ts` (scoped listing queries)
- Create routes under `src/app/api/share/v1/`: `ping/route.ts`, `claim/route.ts`, `library/route.ts`, `titles/route.ts`, `titles/[id]/route.ts`, `disks/[id]/files/route.ts`, `disks/[id]/bytes/route.ts`, `covers/[id]/route.ts`
- Test: `src/lib/share/listing.db.test.ts`, `src/app/api/share/v1/share-api.db.test.ts`

**Interfaces — Consumes:** Task 2. **Produces (wire format, v1):**
```ts
// GET ping            → {ok:true, protocol:1}                              (no auth)
// POST claim          ← {code, protocol, instanceUrl, instanceName} → {token, protocol:1, library:{name}} | 404 {error:'invalid_or_used'} | 409 {error:'protocol', supported:[1]}
// GET library         → {name, collections:[{id,name,titles}], titles, disks}
// GET titles?collection=&q=&cursor=&limit=  → {titles: ShareTitle[], nextCursor: string|null}
// GET titles/{id}     → {title: ShareTitle, disks: ShareDisk[]}
// GET disks/{id}/files → {volume: {...VolumeInfo, dates ISO}, root: ShareEntry[], usage} | {unreadable: reason}
// GET disks/{id}/bytes → application/octet-stream, ETag "<sha256>", Content-Length
// GET covers/{id}     → image bytes (title id); 404 when none
export type ShareTitle = { id: string; title: string; year: number|null; publisher: string|null; kind: string|null;
  diskCount: number; hasCover: boolean; collectionIds: string[] };
export type ShareDisk = { id: string; name: string; diskNo: number; sizeBytes: number; sha256: string;
  imageFormat: string; extractable: boolean; updatedAt: string };
export type ShareEntry = { name; kind:'file'|'dir'; sizeBytes; modifiedAt: string|null; protection; comment; children?: ShareEntry[] };
```
`library.name`: the owner org's name (auth `organization` table), fallback "WebFloppy library".

Rules:
- Every handler: `export const dynamic = 'force-dynamic'`; responses via `shareJson(body, status)` which sets `X-WebFloppy-Share-Protocol: 1` and `Cache-Control: no-store`.
- Auth: `authenticateShare(req.headers.get('authorization'))`; null → 401 `{error:'unauthorized'}` (revoked and unknown alike).
- Rate limit with a module-level `SlidingWindowLimiter` (`src/lib/url-fetch-limit.ts`): key `share:<shareId>:list` 120/60 s, `share:<shareId>:bytes` 30/60 s, claim `share-claim:<ip>` 10/60 s (ip from `x-forwarded-for` first entry, else `x-real-ip`, else 'unknown'). Over limit → 429 with `Retry-After`.
- Scope: anything not in scope → 404 `{error:'not_found'}`; `bytes` re-checks `diskInScope` at request time.
- `titles` paging: `limit` default 48 max 200, cursor = opaque base64url of `{sortTitle, id}`; filter `q` with ILIKE on title (escape `%_`); `collection` must be in `scopedCollectionIds` else 404.
- `files`: `diskStore.read(sha)` → `readVolume` / `readUsage` (`src/lib/adffs`), serialise Dates to ISO; HFE/non-extractable → `{unreadable: extract_reason}`.
- `covers`: resolve via `coverUrlsForGames(orgId,[id])`/`effectiveCoverUrl`; read from `imageStore` (`/api/images/<sha1>`) or `coverStore` (override) directly; send with `Content-Type` from store, `Content-Security-Policy: sandbox`.
- `bytes`: `export const maxDuration = 60`; `diskStore.read`.

- [ ] **Step 1: Failing tests** (db, call route handlers directly with `new Request(...)`): ping returns protocol; claim happy path, reuse → 404 invalid_or_used, protocol 2 → 409; library lists only scoped collections; titles paging stable across two pages and `q` filter; title out of scope → 404; disk bytes in scope → bytes + ETag; **remove title from collection then bytes → 404** (Review Focus 1); revoked token → 401 on every route; 31st bytes request in a minute → 429; files for a seeded formatted ADF (`formatVolume` from the adffs writer used by `e2e/device-write.spec.ts`) returns root entries with ISO dates; header present on every response including 404/401/429.
- [ ] **Step 2: Run** `pnpm test:db src/app/api/share src/lib/share/listing.db.test.ts` — Expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected PASS. Also `pnpm test` (unit) and `pnpm exec tsc --noEmit -p .` clean for new files.
- [ ] **Step 5: Commit.**

---

### Task 4: Owner UI — Settings › Sharing, reachability, pin, landing page

**Files:**
- Create: `src/lib/share/instance.ts` (public origin, reachability test, Caddy root pin), `src/app/api/shares/route.ts` (GET list, POST create), `src/app/api/shares/[id]/route.ts` (PATCH scope, DELETE), `src/app/api/shares/[id]/revoke/route.ts` (POST), `src/app/api/shares/reachability/route.ts` (GET)
- Create: `src/components/prefs/sharing-settings.tsx` (client), `src/app/s/[code]/page.tsx` (landing, outside `(app)`, no sign-in)
- Modify: `src/app/(app)/settings/page.tsx` (SECTIONS entry `{href:'#sharing', label:'Sharing', focusId:'sharing-heading'}` + render)
- Test: `src/lib/share/instance.test.ts`, `e2e/sharing-owner.spec.ts`

**Interfaces — Produces:**
```ts
export function publicOrigin(): string                      // new URL(process.env.BETTER_AUTH_URL!).origin
export function shareLink(code: string, pin: string|null): string   // `${origin}/s/${code}` + (pin ? `#pin=${pin}` : '')
export async function localRootPin(): Promise<string|null>  // base64url sha256 of the DER of /data/caddy/caddy/pki/authorities/local/root.crt when WEBADF_URL is set and WEBADF_DOMAIN is not (tls internal); null otherwise or unreadable
export async function checkReachability(): Promise<{ ok: boolean; origin: string; detail?: string }>  // shareGet(origin + '/api/share/v1/ping') through Task 5's client with the local pin
```
Routes use `requireOrg()`; JSON in/out; create returns `{share, link}` (the only time the link exists).

UI (`SharingSettings`, card `id="sharing"`, heading `id="sharing-heading"`, data-testids `sharing-*`):
reachability line ("Your WebFloppy is reachable at <origin> ✓" / red "Other servers can't reach <origin>: <detail>" +
link `/help#sharing`); table Person · Collections · Status · Last used · actions; **New share…** dialog (label input,
"Everything" checkbox, collection checkboxes from `listCollections`) → shows the link with Copy and "It works once.
Unclaimed links expire on <date>."; **Edit collections…**; **Revoke…** with confirm text "<label> loses access
immediately. Disks <label> has changed stay theirs."; **Delete** on revoked/expired rows.

Landing `/s/[code]`: server page, `headers` `Referrer-Policy: no-referrer` (set in `next.config` headers for `/s/:path*`,
plus `Cache-Control: no-store`), text "A WebFloppy library was shared with you. Open your WebFloppy and paste this link
in Remote › Add.", the full link (from `headers()` host + path; the `#pin` fragment is client-only, so a small client
component reads `location.href`), and a form "Where is your WebFloppy?" that navigates to
`<address>/remote/add#link=<encodeURIComponent(location.href)>`. Never calls claim. Do not reveal the library name
(unclaimed codes must not leak anything; spec text said name — ruling: generic text, see Review Focus 5 rationale).

- [ ] **Step 1: Failing tests:** instance.test: `shareLink` with/without pin; `localRootPin` reads a fixture PEM (generate with `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=t -days 1` in the test via node:crypto `X509Certificate` fingerprint check) and returns null when env has `WEBADF_DOMAIN`. e2e `sharing-owner.spec.ts` (`bash scripts/e2e-local.sh e2e/sharing-owner.spec.ts`): sign up, create two collections, New share for "Rob" with one collection → link shown matching `/s/wfsc_`; table shows Waiting; Edit to Everything; Revoke → Revoked; Delete removes the row; landing page for the code shows the paste instructions and the address form builds `…/remote/add#link=`.
- [ ] **Step 2: Run** — Expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** unit + the e2e spec — Expected PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: Guarded share client (recipient → owner)

**Files:**
- Create: `src/lib/share/client.ts`, `src/lib/share/link.ts`
- Test: `src/lib/share/client.test.ts`, `src/lib/share/link.test.ts`

**Interfaces — Consumes:** `isPublicAddress`, `defaultResolver` from `src/lib/url-fetch.ts` (reuse; do not modify its behaviour). **Produces:**
```ts
// link.ts
export type ParsedLink = { origin: string; code: string; pin: string|null };
export function parseShareLink(raw: string): ParsedLink | null
// accepts: whitespace around; trailing slash; `<origin>/s/<code>[#pin=..]`; `<anything>/remote/add#link=<encoded>` (decode and recurse once);
// code must match /^wfsc_[A-Za-z0-9_-]{43}$/; origin must be https (or http when WEBADF_SHARE_TEST_INSECURE=1).
// client.ts
export type ShareFailure = 'unreachable' | 'ended' | 'protocol' | 'not_found' | 'rate_limited' | 'invalid_or_used' | 'too_large' | 'bad_response';
export type ShareResult<T> = { ok: true; value: T; etag?: string } | { ok: false; failure: ShareFailure; detail?: string };
export type ShareTarget = { origin: string; pin: string|null; token?: string };
export type ShareTransport = (req: { url: URL; method: 'GET'|'POST'; headers: Record<string,string>; body?: string;
  address: string; pin: string|null; timeoutMs: number; maxBytes: number }) => Promise<{ status: number; headers: Record<string,string>; body: Uint8Array }>;
export function shareClient(deps?: { resolve?: typeof defaultResolver; transport?: ShareTransport; env?: NodeJS.ProcessEnv }): {
  ping(t: ShareTarget): Promise<ShareResult<{ protocol: number }>>;
  claim(t: ShareTarget, code: string, me: { instanceUrl: string; instanceName: string }): Promise<ShareResult<{ token: string; library: { name: string } }>>;
  getJson<T>(t: ShareTarget, path: string): Promise<ShareResult<T>>;          // path under /api/share/v1/
  getBytes(t: ShareTarget, path: string): Promise<ShareResult<Uint8Array>>;   // etag returned
};
```
Rules: resolve host → every address must pass `isPublicAddress` unless private allowed (`env.WEBADF_SHARE_PRIVATE_ADDRESSES === '1'`), loopback only with `WEBADF_SHARE_TEST_INSECURE=1`; connect to the vetted address (pin `lookup`, set `servername`), `agent:false`, no redirects (3xx → `bad_response`); with `pin`: `rejectUnauthorized:false` and on `secureConnect` walk `getPeerCertificate(true)` issuer chain to the self-signed root, compare base64url(sha256(root.raw)) to pin, else destroy → `unreachable` detail 'certificate'; without pin: normal verification. Status mapping: 401 → ended, 404 with `invalid_or_used` → invalid_or_used, other 404 → not_found, 409 → protocol, 429 → rate_limited, 5xx/network/timeout → unreachable, body over limit → too_large. Response header protocol missing → `bad_response`. Default transport uses `node:https` (or `node:http` only under TEST_INSECURE).

- [ ] **Step 1: Failing tests** (inject `resolve` + `transport`): private address refused by default, allowed with `PRIVATE_ADDRESSES=1`; loopback refused even then unless TEST_INSECURE; http origin refused unless TEST_INSECURE; 302 → bad_response; status mapping table; oversize → too_large; protocol header missing → bad_response; claim sends JSON body with protocol 1. link.test: the five shapes in Review Focus 4 plus garbage → null, wrong prefix → null. Pin verification: unit-test the pure `rootPinMatches(chain, pin)` helper with two generated certs (node:crypto `X509Certificate`).
- [ ] **Step 2: Run** `pnpm test src/lib/share/client.test.ts src/lib/share/link.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit.**

---

### Task 6: Hidden rows never reach local views

**Files:**
- Modify (add `isNull(games.remoteLibraryId)` / `isNull(disks.remoteLibraryId)` to each query): `src/lib/queries.ts` (listGames ×3 branches, countGames, countAllGames, coverUrlsForGames, kindsForGames, getGameDetail), `src/lib/collections.ts` (listCollections counts, countUncategorized, collectionMosaics, listCollectionGameIds), `src/lib/search.ts`, `src/lib/nfc/store.ts`, `src/lib/demozoo/queries.ts`, `src/lib/disk-set-search.ts`, `src/lib/disk-set-store.ts`, `src/lib/next-disk.ts`, `src/lib/live-state.ts` (keep hidden disks visible as "mounted" in device state but label them; see rule), `src/lib/admin-queries.ts`, `src/app/api/games/bulk/route.ts`, `src/app/(app)/disks/[id]/files/page.tsx`, `src/app/(app)/games/[id]/page.tsx` (404 for hidden)
- Modify (exclude hidden from identification): `src/lib/tosec-apply.ts` (applyMatch / mergeDuplicates), `src/lib/openretro-apply.ts`, `src/lib/demozoo/apply.ts`
- Test: `src/lib/remote-hidden.db.test.ts`

Rule: hidden = `games.remote_library_id IS NOT NULL` (and its disks). Library, search, collections, counts, NFC lists,
demozoo queue, next-disk, disk sets, admin counts, game/disk pages: excluded. Device/drive state (`live-state`,
`drive-chips`) still shows what is mounted, using the hidden title's name with suffix " (remote)". Identification
sweeps never touch hidden rows (they would retitle or merge them).

- [ ] **Step 1: Failing test:** seed org A with one local title (in a collection) and one hidden title+disk (remote_library_id set to a seeded remote library). Assert, for each function in the Files list, that the hidden title/disk is absent and the local one present: listGames (all/collection/uncategorized), countGames, countAllGames, listCollections counts, countUncategorized, search, listDisksForNfc, listReviewQueue, searchCandidates, next-disk candidate, adminCounts, getGameDetail(hidden) === null; tosec `applyMatch` with a TOSEC entry matching the hidden disk's sha leaves the hidden game's title unchanged and does not merge it into a same-named local title; liveStateRows for a device with the hidden disk mounted shows "<title> (remote)" (Review Focus 2).
- [ ] **Step 2: Run** `pnpm test:db src/lib/remote-hidden.db.test.ts` — FAIL.
- [ ] **Step 3: Implement** the filters.
- [ ] **Step 4: Run** it plus the whole `pnpm test:db` and `pnpm test` — PASS (fix any test that seeded rows without the new columns only if the assertion was wrong; record in report).
- [ ] **Step 5: Commit.**

---

### Task 7: Recipient store, materialise and first-write

**Files:**
- Create: `src/lib/remote/crypto.ts`, `src/lib/remote/store.ts`, `src/lib/remote/cache.ts`, `src/lib/remote/materialise.ts`
- Modify: `src/lib/disk-history/store.ts` (`recordVersion`: D2 inside `build(tx)`)
- Test: `src/lib/remote/crypto.test.ts`, `src/lib/remote/store.db.test.ts`, `src/lib/remote/materialise.db.test.ts`, `src/lib/disk-history/remote-first-write.db.test.ts`

**Interfaces — Consumes:** Task 5 `shareClient`, `parseShareLink`; Task 1 tables. **Produces:**
```ts
// crypto.ts
export function sealToken(plain: string): string    // 'v1.' + base64url(iv12 | ct | tag16), key = hkdfSync('sha256', BETTER_AUTH_SECRET, Buffer.alloc(0), 'webadf-share-token', 32)
export function openToken(sealed: string): string
// store.ts
export type RemoteLibraryRow = { id; name; baseUrl; status: 'ok'|'unreachable'|'ended'|'protocol'; lastOkAt; lastError; addedAt };
export async function addRemoteLibrary(orgId, userId, rawLink: string, deps?: { client?: ReturnType<typeof shareClient> })
  : Promise<{ ok: true; id: string } | { ok: false; reason: 'bad_link'|'invalid_or_used'|'unreachable'|'protocol'|'already_added'; detail?: string }>
export async function listRemoteLibraries(orgId): Promise<RemoteLibraryRow[]>
export async function getRemoteTarget(orgId, id): Promise<{ row: RemoteLibraryRow; target: ShareTarget } | null>
export async function remoteCall<T>(orgId, id, path: string, deps?): Promise<ShareResult<T>>   // getJson through cache.ts (60 s), updates status/lastOkAt/lastError; 'ended' → endRemoteLibrary
export async function endRemoteLibrary(orgId, id): Promise<void>    // status 'ended' + purgeHidden
export async function removeRemoteLibrary(orgId, id): Promise<boolean>   // purgeHidden then delete row
export async function purgeHidden(orgId, remoteLibraryId): Promise<{ ejected: number; deleted: number }>
// cache.ts
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>   // Map with expiry; only ok results cached; max 500 entries (drop oldest)
// materialise.ts
export async function materialiseRemoteDisk(orgId, remoteLibraryId, remoteTitleId, remoteDiskId, deps?)
  : Promise<{ ok: true; diskId: string } | { ok: false; reason: 'not_shared'|'ended'|'unreachable'|'too_large'|'mismatch'|'protocol' }>
```
Rules:
- `addRemoteLibrary`: `parseShareLink`; same origin already added for this org with status ok → `already_added`; claim with `instanceUrl = publicOrigin()`, `instanceName` = org name; store sealed token, pin, name.
- `materialiseRemoteDisk`: the share API has no single-disk route, so the caller passes the title id. Steps: always fetch fresh `titles/{remoteTitleId}` (uncached) to confirm the disk is still in scope and get its current sha256 (404 → `not_shared`); find existing hidden disk `(org, remote_library_id, remote_disk_id)`; if present with same sha → return its id; else `getBytes`, verify sha256(bytes) === ETag === listing sha (else `mismatch`); `diskStore.put`; insert blobs (onConflictDoNothing), entitlement; upsert hidden game `{id: stableId('rgame', orgId, remoteLibraryId, remoteTitleId), orgId, title, sortTitle: makeSortTitle(title), remoteLibraryId, remoteTitleId, metadataSource: 'remote'}` and hidden disk `{id: stableId('rdisk', orgId, remoteLibraryId, remoteDiskId), …, sha256, sizeBytes, diskNo, writeProtected: false, remoteLibraryId, remoteDiskId}` (update sha on an existing untouched row). Use `atomic`.
- `purgeHidden`: for each hidden disk: `ejectDf1Holders(orgId, ids)` and `clearDesired` for any device whose desired/mounted disk is one of them (Review Focus 3), then delete hidden disks, their entitlements unless another disk of the org has the same sha, then hidden games.
- D2 in `recordVersion`'s transaction: if the disk row has `remoteLibraryId`, set `remote_library_id = NULL, remote_disk_id = NULL` on the disk and on its game (game id unchanged; title already Uncategorized since hidden games are in no collection).

- [ ] **Step 1: Failing tests:** crypto round trip; tampered ciphertext throws; different secret fails. store (fake client): bad link, claim failure mapping, already_added, add happy path stores sealed token (not plaintext); remoteCall caches 60 s (second call no client hit; after `vi.setSystemTime(+61s)` hits again); 401 → status ended and hidden rows purged; materialise (fake client returning bytes): creates hidden pair with writeProtected false; second call reuses; owner sha changed → row updated; ETag mismatch → `mismatch`; titles/{id} 404 → `not_shared` and nothing created (Review Focus 1). purge with the hidden disk desired on a seeded device → device desired cleared before rows deleted (Review Focus 3). first-write: `recordVersion` with source 'amiga' on a hidden disk → disk and game remote columns null, listGames uncategorized now includes it.
- [ ] **Step 2: Run** `pnpm test src/lib/remote/crypto.test.ts && pnpm test:db src/lib/remote src/lib/disk-history/remote-first-write.db.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + full `pnpm test:db` — PASS.
- [ ] **Step 5: Commit.**

---

### Task 8: Recipient routes

**Files:** under `src/app/api/remote/`: `route.ts` (GET list, POST add `{link}`), `[id]/route.ts` (DELETE remove), `[id]/library/route.ts`, `[id]/titles/route.ts`, `[id]/titles/[titleId]/route.ts`, `[id]/disks/[diskId]/files/route.ts`, `[id]/disks/[diskId]/mount/route.ts` (POST `{titleId, deviceId, drive:'df0'|'df1'}`), `[id]/disks/[diskId]/send/route.ts` (POST `{titleId, deviceId}`), `[id]/disks/[diskId]/download/route.ts` (GET `?titleId=`), `[id]/covers/[titleId]/route.ts`
- Test: `src/app/api/remote/remote-api.db.test.ts`

Rules: `requireOrg()`; all proxy calls via `remoteCall`; failures map to HTTP: ended 410 `{error:'ended'}`, unreachable 502 `{error:'unreachable', host}`, protocol 409, not_found/not_shared 404, rate_limited 429. Mount: `materialiseRemoteDisk` → `setDesired` (df0) or `mountToDf1` (df1) → same JSON as `/api/devices/[id]/mount`. Send: materialise → reuse the logic of `POST /api/transfers/from-disk` with `{deviceId, diskId, whole: true}` (extract a shared function `queueWholeDiskSend(db, orgId, userId, deviceId, diskId)` from that route rather than calling it over HTTP; keep the route's behaviour identical). Download: `getBytes` verify sha → attachment `<title> - Disk <n>.adf`, not cached as a row. Covers: proxied bytes, `Cache-Control: private, max-age=3600`.

- [ ] **Step 1: Failing tests** with a fake client injected (export a `setShareClientForTests` seam in `store.ts`): list/add/remove; titles proxied and cached; ended → 410 and library status ended; mount creates hidden row and sets desired on the device; send queues a transfer; download returns bytes with attachment header; another org's remote library id → 404.
- [ ] **Step 2–4:** run `pnpm test:db src/app/api/remote` FAIL → implement → PASS; `pnpm test` PASS (the from-disk route's existing tests still pass after the extraction).
- [ ] **Step 5: Commit.**

---

### Task 9: Recipient UI

**Files:**
- Modify: `src/components/shell/top-nav.tsx` (ITEMS: Library, Remote `{href:'/remote', label:'Remote', phone:false}`, Devices, Upload, Help), `src/lib/nav-tabs.ts` (`MORE_ROUTES` gains Remote so phones reach it via More), `src/components/shell/top-nav.test.ts` (expected list), `src/proxy.ts` (matcher gains `'/remote/:path*'`)
- Create pages: `src/app/(app)/remote/page.tsx`, `src/app/(app)/remote/add/page.tsx` (client reads `#link=`, posts, redirects to the library), `src/app/(app)/remote/[id]/page.tsx` (collections side list + titles, cards/table toggle, search box scoped to this remote, pager), `src/app/(app)/remote/[id]/titles/[titleId]/page.tsx` (disks with Mount/Send/Download), `src/app/(app)/remote/[id]/disks/[diskId]/page.tsx` (files, read-only tree)
- Create components: `src/components/remote/*` (RemoteLibraryCard, AddRemoteForm, RemoteTitleGrid, RemoteTitleTable, RemoteDiskActions, RemoteMarker, RemoteStatus) — reuse leaf pieces only: `Cover`, `titleByline`, `kindTag`, `LibraryPager`, `resolvePage`, `PageHeader`, `StateCard`, `mountChoices` + the drive picker markup from `src/components/games/mount-action.tsx` (call the remote mount route), `SendBoardPicker` context from `listSendTargets`. Do not reuse `GameGrid`/`GameTable` (they carry local actions and drag-and-drop).
- Test: unit tests for the pure copy helper `remoteErrorText(failure, host)` in `src/lib/remote/copy.test.ts`; the rendered pages are exercised end to end in Task 11.

UI rules: page header eyebrow "Remote", title the library name, `RemoteMarker` "Remote · <name>" on every remote page; status pill ok/unreachable/ended/protocol with the Global Constraints copy; Ended libraries show only Remove; empty `/remote` explains and offers Add; phone layout single column like the library; data-testids `remote-*`. Mount on a disk whose title left scope shows "No longer shared" (Review Focus 1).

- [ ] **Step 1: Failing tests:** `remoteErrorText` table; top-nav.test new list; nav-tabs more items include Remote.
- [ ] **Step 2–4:** FAIL → implement → PASS; `pnpm build` passes (the real client-bundle gate).
- [ ] **Step 5: Commit.**

---

### Task 10: Help, self-host setting, docs

**Files:**
- Modify: `src/lib/help/topics.tsx` (topics `sharing` and `remote` in the `server` group), `src/lib/help/topics.test.ts` (IDS 19, group lists), `src/selfhost/app-env.ts` (`if (!env.WEBADF_SHARE_PRIVATE_ADDRESSES?.trim()) env.WEBADF_SHARE_PRIVATE_ADDRESSES = '1'`), `src/selfhost/app-env.test.ts`, `.env.example`, `docs/self-hosting.md` (section "Sharing your library": reachability, the setting, Caddy internal root and pinned links, what to forward), `playwright.config.ts` (web server env `WEBADF_SHARE_TEST_INSECURE=1`, `WEBADF_SHARE_PRIVATE_ADDRESSES=1`)
- Caddy root readability: check `docker/` setup: if Caddy creates `pki/authorities/local` 0700 root-owned, add to the setup service a step that copies `root.crt` to `/data/caddy-root.crt` with mode 0644 after Caddy first starts (or point `localRootPin` at a world-readable copy the caddy service writes via its entrypoint). Decide by reading Caddy's behaviour and verify in Task 12.
- Help bodies 60-280 words, no banned words (PSRAM, TBYB, poll, sha256, cursor, WPROT). `sharing`: how to share, reachability options (port 443 forward, reverse proxy, Tailscale Funnel, Cloudflare Tunnel), trusted vs internal certificate (internal works on a LAN; the link carries what the other side needs), what recipients can do, saving makes a copy theirs, Revoke. `remote`: Add, Mount/Send/Download, saving makes it yours, Access ended.
- [ ] Steps: tests first (topics.test, app-env.test) FAIL → implement → PASS; commit.

---

### Task 11: End-to-end, two orgs on one server

**Files:** Create `e2e/sharing.spec.ts` (use `bash scripts/e2e-local.sh e2e/sharing.spec.ts`; split with `-g` if over 9 min).

Flow (two browser contexts, `signUpFresh` each): owner seeds a formatted ADF title in collection "Shared" and another in "Private" (`formatVolume`, `diskStore.put`, `seedDisk`, collection via UI or API); New share "Rob" → link. Recipient: Remote › Add with the link wrapped in spaces (Review Focus 4) → library opens, shows "Shared" title only; title page lists the disk; files page lists root; Download returns ADF bytes equal to the owner's; pair a device (`pairDevice`) and Mount DF0 → POST `/api/device/status` + write a track + close (as `e2e/device-write.spec.ts` `mountedWritableDisk`) → the disk appears in the recipient's local library under Uncategorized (D2). Owner removes the remaining shared title from "Shared" → recipient Mount shows "No longer shared". Owner revokes → recipient's next page load shows Access ended; hidden copies gone; the D2 local disk remains. Reusing the claim link from a third context → "This link was already used, has expired or was revoked".

- [ ] Steps: write spec, run (expect failures only from real defects; fix in the owning module with a unit test first), PASS, commit.

---

### Task 12: Self-host parity on the OMV server (controller-run)

Not dispatched to a subagent (production-adjacent, SSH). The controller: builds and pushes nothing new to ghcr (master push does that after merge) — instead runs the branch image built locally (`docker buildx build --platform linux/amd64 -t webadf:share-test -f docker/Dockerfile .`, `docker save | ssh root@172.16.10.11 docker load`), points the existing OMV install at that tag (`WEBADF_IMAGE_TAG`) via the command line, verifies: Caddy root readable by the app (`localRootPin` non-null), owner on OMV (`tls internal`, pinned link) → recipient = local dev server on the Mac (`PORT=3100`, `WEBADF_SHARE_PRIVATE_ADDRESSES=1`); then OMV as recipient of a share from the Mac dev server is NOT possible over https (dev is http) — instead a second org on OMV shares to the Mac. Record results in HANDOFF; keep the OMV install running. Hardware bench (A500 save to a remote disk) is owed to the operator.

---

## Self-review notes

- Spec §3.4 says the landing page shows the library name; the plan shows generic text (ruling: an unclaimed code must reveal nothing; the name appears after claim). Recorded as a ruling in the ledger.
- Spec §3.2 has no single-disk route; materialise uses `titles/{id}` (fresh) + `disks/{id}/bytes`. Recorded.
- Spec §4.1 FK "cascade only through removal path": implemented as no FK cascade + explicit `purgeHidden`.
