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
| 2 — unscoped admin queries | ⚠️ **implemented and committed (`40890c9`), NOT REVIEWED** |
| 3 — admin shell, overview, user list | not started |
| 4 — invites issue/revoke | not started |
| 5 — cascade delete | not started |
| 6 — docs + bootstrap runbook | not started |

**Resume by running Task 2's task review first**, then continue with Task 3. The plan and spec
are self-contained; a fresh session needs no other context.

Suite at the pause point: **256 vitest**, `pnpm build` clean. Playwright untouched (87).

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

- **Task 2 is unreviewed.** Run its task review before anything else.
- **Task 2's known limitation, needs a ruling:** a user can hold multiple `auth.member` rows
  (see `auth.ts`'s `lookupActiveOrgId` comment), and `adminListUsers`'s plain LEFT JOIN would
  fan such a user into duplicate rows. Unreachable today at one org per user; the admin list is
  also exactly where a broken multi-member account should be visible. Decide whether to accept,
  or use `DISTINCT ON`/`LATERAL`.
- **Deferred from Task 1:** nothing tests `requireSuperAdmin` itself, so `/sign-in` versus
  `/library` targeting is unverified by Vitest. Task 3's e2e covers both — check it does.

## Two defects this plan's own text contained

Both found by implementers, both would have failed at runtime rather than at build:

1. Task 1's Step 3 imported `@/lib/auth` at module top, but `auth.ts` calls `getDb()` as a
   module-level side effect and Vitest has no `DATABASE_URL`. Resolved by splitting the pure
   functions into `src/lib/superadmin-allowlist.ts`.
2. Task 2's snippet used `const [row] = await getDb().execute(...)`. The neon-http driver
   returns `{ rows: T[] }`, not an array — `.rows[0]` is correct.
