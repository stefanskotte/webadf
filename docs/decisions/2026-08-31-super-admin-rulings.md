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
| 5 — cascade delete | not started |
| 6 — docs + bootstrap runbook | not started |

**Resume at Task 5 (cascade delete).** The plan and spec are self-contained; a fresh session
needs no other context.

Suite: **256 vitest**, **102 Playwright** (87 + 15 admin), `pnpm build` clean.

**The admin plane is usable now, at `/admin`.** Issuing an invite from `/admin/invites` is the
only way to open registration again — the database still holds zero live codes.

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
