# Super-admin plane — rulings and in-flight state

**Written 2026-08-31 mid-plan, as a context handoff.** The SDD ledger under `.superpowers/`
is gitignored and does not survive a session, so everything worth keeping is here.

**Branch:** `feat/super-admin`, forked from `master` at `f692321`.
**Spec:** `docs/superpowers/specs/2026-08-31-super-admin-plane-design.md`
**Plan:** `docs/superpowers/plans/2026-08-31-super-admin-plane.md` (6 tasks)

## Where execution stopped

| Task | State |
|---|---|
| 1 — `requireSuperAdmin` + allowlist | ✅ complete, reviewed clean (`f692321`..`485fbb1`) |
| 2 — unscoped admin queries | ✅ complete, **reviewed 2026-08-31** (`40890c9`, fix `62192e0`) |
| 3 — admin shell, overview, user list | ✅ complete (`768dc61`), guard mutation-checked |
| 4 — invites issue/revoke | ✅ complete (`5ac7575`), both mutation proofs run |
| 5 — cascade delete | ✅ complete (`bdc45f5`), both mutation proofs run |
| 6 — docs + bootstrap runbook | ✅ complete |

**All six tasks are done.** Suite: **256 vitest**, **107 Playwright** (87 + 20 admin),
`pnpm build` clean. The branch is not merged to `master`.

**The only outstanding step is bootstrap step 3** — setting `SUPERADMIN_EMAILS` in Vercel
production — and it should stay outstanding until the branch merges. `/admin` does not exist in
production until then, which is the correct state.

## Task 2's review (2026-08-31)

Task 2 ships no Vitest coverage by design -- every function opens a database connection and
this repo's Vitest has no `DATABASE_URL`. The review therefore ran all four functions
**read-only against the live database** rather than desk-checking them, which is the only way
they can actually be exercised before Task 3's Playwright specs exist. Findings:

**One real defect, fixed (`62192e0`): `adminListUsers` could skip a user.** It ordered by
`created_at DESC` alone. That column is *not unique* in the live database -- five groups of
users share a timestamp, one of them three ways, because the e2e suite signs accounts up in
bursts. `ORDER BY` a non-unique key with `LIMIT`/`OFFSET` is an unstable sort: Postgres may
order tied rows differently for the page-N query and the page-N+1 query, showing one user twice
and skipping another entirely. This list is how an operator finds a user *in order to delete
them*, so a silently skipped row fails in the bad direction. Fixed by adding `user.id` as a
tiebreaker, making the order total (id is the primary key). Verified by walking all 2,863 users
in pages of 500: 2,863 fetched, 2,863 distinct, zero duplicates, zero skips.

**Everything else verified correct against real data:**

- `adminCounts` returns `{users: 2863, orgs: 2862, games: 739, disks: 876, blobs: 802,
  liveInvites: 0}`. The `::int` casts work -- values arrive as JS numbers, not strings. The
  `liveInvites: 0` independently confirms the bootstrap step-2 revocation recorded below.
- The `.rows[0]` correction the plan's own text got wrong (it wrote `const [row] = await
  ...execute()`) is applied correctly; the neon-http driver does return `{ rows }`.
- **The LEFT joins are load-bearing and demonstrably so.** 2,863 users against 2,862
  organizations -- there is exactly one real user with no membership at all
  (`t-1788049672913-737154@example.test`). An inner join would hide them, and the admin list is
  precisely where a failed organization bootstrap should be visible.
- `createdAt` arrives as a real `Date`; the correlated `games`/`disks`/`devices` counts arrive
  as numbers and are 0 (not null) for the membership-less user.
- `adminListInvites`' SQL-derived state and its live-first ordering both execute correctly.

**Not exercised by real data, for Task 4's e2e to cover:** all 2,371 invite rows are
`consumed` -- there is not one `live` or `expired` row in the database, so neither the
`expired` branch of the state `case` nor the live-first ordering has ever produced a non-trivial
result.

**Cosmetic, deliberately left alone:** `adminCounts` reads `rows[0]` unguarded while its sibling
`adminCountUsers` guards with `?? 0`. The query is six scalar subqueries and always returns
exactly one row, so the guard would be dead code.

## Rulings taken

**Ruling 1 — the two `SUPERADMIN_EMAILS` values are deliberate and must not be unified.**
`.env.local` (gitignored, local) holds `admin@example.test` so the e2e suite can sign in as an
admin. Vercel production holds the operator's real address. A single shared value would either
put a test account in production's allowlist or make the e2e unable to run.
*Costs if wrong: none identified — the two files never travel together.*

**Ruling 2 — Task 5's cascade e2e deletes real rows from the live database, and that is accepted.**
Every e2e in this repo runs against the live Neon database; Task 5 additionally *deletes* a user
and their catalog. It only touches orgs it created via `signUpFresh` in the same test.
*Costs if wrong: a targeting bug could delete a real org. Mitigated by there being zero
non-test accounts today, and by the delete being keyed on a user the test just created.*

**Ruling 3 — the bootstrap ordering is a Task 6 runbook step, not something the plan executes.**
Claiming the operator's email and setting the production env var are operator actions with
security consequences, and the env var is a side effect outside the branch.
*Costs if wrong: the plane ships with no admin configured, which fails closed.*

**Ruling 4 — `adminListUsers`' multi-membership fan-out is ACCEPTED, not fixed.**
The open item below asked whether to defend the plain LEFT JOIN with `DISTINCT ON`/`LATERAL`
against a user holding two `auth.member` rows. **Measured on the live database: zero users hold
more than one membership**, and the full paging walk returned exactly 2,863 rows for 2,863
users, so there is no fan-out to defend against. Accepted for the reason the code's own comment
gives: nothing in this app's sign-up or invite flow creates a second membership, and if one ever
appears, the admin list is exactly where a broken multi-member account *should* be visible
rather than silently collapsed by a `DISTINCT`.
*Costs if wrong: a user with two memberships appears twice on the list and inflates the page
against `adminCountUsers`' total. Detectable the moment it happens, because the two counts stop
agreeing.*

## Tasks 3 and 4 — what deviated from the plan's text

Four deviations, all deliberate. None changes what the plane does; each is somewhere the plan's
own snippets would have failed if typed in literally.

**1. The operator asked for a top-nav link, and it is gated server-side.** Not in the plan --
requested mid-session, on the grounds that the operator is an ordinary user of webadf as well as
its admin and should not have to remember the URL. `(app)/layout.tsx` decides with
`isSuperAdminEmail()` and passes a plain boolean to `TopNav`, so **the allowlist itself never
reaches the client** -- a client component cannot read `SUPERADMIN_EMAILS`, and shipping it to
the browser to let one try would publish the very thing the env var exists to keep out of the
database. `requireOrg()` now also returns the session email it already had loaded, so the shell
pays no second `getSession()` for this.

Hiding a link is presentation, not access control -- `requireSuperAdmin()` is the guard. But it
does preserve the plane's **non-disclosure** property: a non-admin is redirected to `/library`
rather than 404'd precisely so the response never confirms `/admin` exists, and a link rendered
for everyone would have leaked it in the markup regardless. Tested in both directions -- a
non-admin's page contains no `/admin` at all, and the admin reaches the overview by clicking.

**2. An unauthorized API caller gets a 307, not a 4xx.** Task 4's snippet asserted
`[302, 401, 403, 404]`. This codebase redirects instead (`requireOrg()` does it everywhere, and
`e2e/mount-actions.spec.ts` asserts exactly that), and **Playwright follows redirects by
default**, so the assertion would have failed against a route that was working. The tests pass
`maxRedirects: 0` and assert the 307 plus its `Location` -- `/library` for a signed-in
non-admin, `/sign-in` for an anonymous one. Reusing `requireSuperAdmin()` unchanged is also what
the plan's own global constraint asks for, so no second API-shaped guard was introduced.

**3. One element cannot carry two `data-testid` values.** The plan asked for both
`admin-user-row` and `user-row-<email>` on the row. The row keeps the countable testid plus a
`data-email` attribute; the email cell carries the per-email testid. **Task 5 should target a
row with `[data-testid="admin-user-row"][data-email="..."]`.**

**4. `/admin/invites` was kept out of Task 3's guard loop until Task 4 built the page.** An
unrouted path 404s before any layout guard runs, so including it early would have asserted
Next's routing rather than `requireSuperAdmin()`. It is in the loop now.

## What the mutation proofs actually showed

Every guard in tasks 3 and 4 was mutation-checked rather than assumed, and one check paid off:

- Removing `requireSuperAdmin()` from the `(admin)` layout **fails** the non-admin redirect test
  -- so it is not passing vacuously on a missing route, which is the trap the plan warned about.
- Dropping the `consumed_at` condition from the revoke **fails** `a consumed code cannot be
  revoked`.
- Removing `requireSuperAdmin()` from both invite routes **fails** the non-admin API test -- but
  **left the anonymous test green**, because `POST` calls `requireOrg()` too and that redirects
  an anonymous caller by itself. The anonymous test was therefore weaker than it looked. It now
  asserts `DELETE` as well, which has no second guard and is the one that actually proves the
  route is protected.

## Task 5 — two more of the plan's own claims were wrong

Both would have failed at runtime, and neither at build time.

1. **There is no transaction available.** The plan says "one transaction". drizzle's neon-http
   session throws *"No transactions support in neon-http driver"* from `.transaction()`.
   `db.batch()` is the atomic primitive that does exist — neon wraps a batch in one server-side
   transaction — so the cascade is built up and submitted as a single batch. It is
   non-interactive, so every read that decides the batch's shape runs first.
2. **`auth.user` does not cascade to the organization.** The plan says it does. `auth.member`
   references both `user` and `organization` with `ON DELETE CASCADE`, but `auth.organization`
   has no foreign key to `auth.user` at all — so deleting a user removes their membership and
   leaves the organization orphaned. Confirmed from the other side by the live counts: 2,863
   users against 2,862 organizations. The org is now deleted explicitly, **only where the
   deleted user was its last member** — an organization someone else is still in is theirs.

**Added beyond the plan:** deleting an allowlisted account is refused with a 409. The allowlist
matches on the *address*, not a user id, so deleting such a row would not revoke anyone's admin
— it would free the address for whoever registers it next, manufacturing exactly the unclaimed
allowlisted address that the bootstrap ordering exists to prevent.

**The confirmation is a centered modal, not a row-anchored popup.** Plan 3b's rulings record a
real wrong-target bug from that shape — an open dropdown covered the next row's Mount button —
and the consequence here is a permanent delete rather than a wrong mount. The typed-email gate
is the stronger protection: the operator must type *that row's* address exactly, so even a
mis-aimed click cannot delete the wrong account.

## The mutation proof that emptied the live catalog

Task 5's second prescribed mutation — drop the `org_id` predicate from the cascade's `games`
delete, and confirm a test notices — is, against a live database, a literal `DELETE FROM games`.
It cascaded to `disks` through `disks.game_id`. **`games` and `disks` are now 0 rows.**

The proof worked: no existing test caught it, so the assertion the plan told us to add if none
did (*the other organization's rows survive*) was added, and it fails under the mutation. The
operator had confirmed beforehand that they needed no data in the system. Blobs (826),
entitlements (902), devices and every account survived, so the ADF bytes and every
organization's claim on them are intact — what was lost is catalog metadata.

**For the next destructive mutation proof:** a mutation that drops a tenant predicate is not
scoped by the test that runs it. Either point the run at a scratch database or accept in advance
that it empties the table for every tenant. This repo has no scratch database — every e2e runs
against live Neon — so today that is an explicit decision to make each time, not something to
walk into by following a plan step.

**The first mutation is more interesting than it looks.** Adding `blobs` to the delete set does
not fail by the blob vanishing — it fails because the *other* organization's `disks` still
reference that sha256, and `disks.sha256`/`entitlements.sha256` reference `blobs.sha256` with no
cascade. The foreign key rejects the delete, and because the batch is atomic the entire cascade
rolls back, so the test fails on the user never being deleted at all. The database enforces the
"never delete a shared blob" rule independently of the code comment that states it.

## The security finding worth remembering

**`toLowerCase()` is not injective, so an "exact match" allowlist was not exact.**
`isAllowed('sfs@enhance-it.dK', …)` returned **true** — U+212A KELVIN SIGN lowercases to `k`.
Likewise `ẞ` vs `ß`. A string that is not the allowlisted address was accepted.

Not exploitable at the time: better-auth's `z.email()` uses an ASCII-only regex that rejects
it at sign-up. But `isAllowed` is documented as "the whole decision" while leaning on an
upstream validator it does not own — add a social or OIDC provider and the guarantee vanishes
silently.

Fixed with an ASCII-only check applied to the **pre-lowercase** string.
**Deliberately not `.normalize('NFKC')`** — that maps U+212A to `K` and makes it worse. The
review verified seven attack payloads are denied *and* that a legitimate unusual-but-ASCII
address (`a+b'c.d_e-f@sub.example.co.uk`) is still accepted, because an over-tight regex is the
same bug wearing the other face.

## Open items for the next session

- ~~**Task 2 is unreviewed.**~~ **DONE 2026-08-31** — reviewed, one real defect found and
  fixed (`62192e0`). See "Task 2's review" above.
- ~~**Task 2's known limitation, needs a ruling**~~ — **RULED, accepted.** See Ruling 4.
- ~~**For Task 4:** the `expired` state and the live-first ordering are unexercised.~~
  **Partly closed.** Task 4's e2e now issues, lists and revokes live codes, so the live path and
  the ordering are covered. **The `expired` branch is still unexercised** — an invite's TTL is
  seven days, so no test can reach it without either waiting or seeding a row with a past
  `expires_at`. Worth doing when something else touches invites.
- **Task 5 targets a user row with `[data-testid="admin-user-row"][data-email="..."]`**, not
  `getByTestId('user-row-<email>')` on the row itself — see deviation 3 above.
- **Bootstrap steps 1 and 2 are DONE** (2026-08-31): `sfs@enhance-it.dk` is claimed with role
  `owner`, and the three leaked codes were deleted. **Zero live invite codes remain**, so
  registration is closed until one is issued. Only step 3 — setting `SUPERADMIN_EMAILS` in
  Vercel production — is outstanding, and it should stay outstanding until the plane ships.
- **Deferred from Task 1:** nothing tests `requireSuperAdmin` itself, so `/sign-in` versus
  `/library` targeting is unverified by Vitest. Task 3's e2e covers both — check it does.

## Two defects this plan's own text contained

Both found by implementers, both would have failed at runtime rather than at build:

1. Task 1's Step 3 imported `@/lib/auth` at module top, but `auth.ts` calls `getDb()` as a
   module-level side effect and Vitest has no `DATABASE_URL`. Resolved by splitting the pure
   functions into `src/lib/superadmin-allowlist.ts`.
2. Task 2's snippet used `const [row] = await getDb().execute(...)`. The neon-http driver
   returns `{ rows: T[] }`, not an array — `.rows[0]` is correct.
