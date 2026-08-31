# Super-admin plane

**Addendum to `2026-08-23-webadf-design.md`.** That spec remains the binding authority. This
one adds an operator-only plane for managing users and invite codes — the first thing in this
codebase that deliberately crosses the organization boundary every other query enforces.

**Scope:** three pages and their mutations. Listing users and deleting one with a real
cascade; issuing and revoking invite codes. Nothing about the device plane, the library, or
ingest changes.

**Realises the operational half of D13.** Registration has been invite-only since plan 1, but
`issueInvite()` has never had a caller — every invite in the database was written by hand or
by an e2e run. This is the surface that was always implied and never built.

---

## 1. The property this plane deliberately breaks

Every query in this codebase is org-scoped. `requireOrg()` returns an `orgId` taken from the
session, and every `select` filters on it. That single discipline is what makes the app
multi-tenant, and plan 3b's review found a live cross-tenant leak the moment one query
relaxed it.

This plane is the exception, and it must be the *only* exception:

> **Exactly one door crosses the org boundary, and it is `requireSuperAdmin()`.**

Two structural consequences, both load-bearing:

- **`src/lib/superadmin.ts` is the only file in the tree that reads the allowlist.** "Who can
  cross the boundary" has one answer in one file, auditable in a sitting.
- **`src/lib/admin-queries.ts` holds every unscoped query**, and nothing outside
  `src/app/(admin)` and `src/app/api/admin` may import it. A future refactor that helpfully
  adds org scoping to a shared helper would break this plane; one that copies an admin query
  into the app plane would leak across tenants. Keeping them in a module with a stated import
  boundary makes both mistakes visible in review.

## 2. Identity: an env-var allowlist, and why not the database

`SUPERADMIN_EMAILS` is a comma-separated list in the environment. `requireSuperAdmin()` reads
the session, lowercases and trims the session email, and requires an **exact** match against
a lowercased, trimmed, comma-split allowlist. Never a substring, never a domain suffix.

It returns `{ userId, email }` and mirrors `requireOrg()`'s shape deliberately, so the two
guards read alike at their call sites — but it returns **no `orgId`**, because this plane has
no organization of its own to scope to. A caller that wants one is on the app plane and should
be using `requireOrg()`.

**Fail closed.** An unset or empty variable means nobody is an admin. This is stated because
the opposite default — "no allowlist configured, so allow everyone" — is a plausible
implementation of the same idea and would be catastrophic.

The alternatives were better-auth's `admin` plugin (present in `node_modules`, and it also
brings impersonation) and a `user.is_superadmin` column. Both were rejected for the same
reason: **they put the grant inside the database.** A single `UPDATE` would confer
cross-tenant access over every organization. With the allowlist outside the database, an
attacker who reaches Postgres still cannot make themselves an operator. Given that this
project already accepts a cross-tenant existence oracle at ingest (parent spec's known risks),
keeping the strongest capability out of the database is worth an env change and a redeploy
when the admin set moves.

A non-admin who reaches `/admin` is redirected to `/library`, not shown a 404 — the redirect
does not confirm whether the route exists.

## 3. The bootstrap hazard, which is a precondition and not a nicety

`emailVerified` defaults to `false` in `auth.ts` and nothing enforces it. `user.email` is
unique, so an address is safe **once claimed** — and at the time of writing there are **zero
non-test accounts in production**, so `sfs@enhance-it.dk` is unclaimed.

An email allowlist deployed before that address is claimed is therefore a prize: anyone
holding a live invite code could register as it and inherit the operator role.

**Required ordering, in this order:**

1. The operator signs up and claims `sfs@enhance-it.dk`, using an existing invite.
2. The four invite codes that leaked into a session transcript are revoked (see §5) —
   `M3W4V3BA`, `K69GXH72`, `HXGMH4ZK`, `56DTUDMA`.
3. `SUPERADMIN_EMAILS=sfs@enhance-it.dk` is set in the Vercel environment.
4. The plane ships.

Steps 1 and 3 are separated on purpose. Once the row exists, uniqueness protects it
permanently, and the allowlist can be deployed with no window.

This is not a defence against a compromised operator account; it is a defence against the
address being *claimable*. Enabling email verification would remove the ordering requirement
entirely, but no mail sending is configured in this app, so that is a separate change.

## 4. Routes

A new `(admin)` route group mirroring `(app)`. Every page is a server component whose first
statement is `requireSuperAdmin()`.

| Route | Contents |
|---|---|
| `/admin` | Counts: users, organizations, games, disks, blobs, live invites. Answers "what is actually in this database". |
| `/admin/users` | Every user with org name, created date, and library size (games / disks / devices). Paginated. Delete per row. |
| `/admin/invites` | Live, consumed and expired codes. Issue; revoke an unconsumed one. |

Mutations are API routes under `src/app/api/admin/`, following the existing route pattern.
**Each calls `requireSuperAdmin()` itself.** The page guard is not the API guard and neither
trusts the other — a page render and a later `fetch` are separate requests, and only the
second is what an attacker would send.

`src/proxy.ts`'s matcher gains `/admin/:path*`. That is the same optimistic cookie check it
already applies to `/library`: it is not authoritative and the guard is what enforces access.

**Pagination is a requirement, not a refinement.** The production database holds 2,862 users
and 2,861 organizations, essentially all of them `@example.test` residue from e2e runs that
never cleaned up the `auth` schema. An unpaginated list is unusable on the only data that
exists.

## 5. Invites

**Issue** calls the existing `issueInvite(orgId, createdByUserId)` with the operator's own org
and user id — 8 characters from the unambiguous alphabet, 7-day TTL, unchanged from plan 1.
The code is displayed once, prominently, with a copy affordance: that is the only moment it
matters.

**Revoke deletes the row, and only for an unconsumed code.** A code nobody redeemed has no
history worth keeping, and deleting it makes `claimInvite`'s
`WHERE consumed_at IS NULL AND expires_at > now()` fail by absence — the same answer as any
other invalid code, with no new failure path to reason about. A *consumed* code is refused:
it is the record that an account was created, and erasing it would destroy the only audit
trail this system has. A `revoked_at` column was considered and rejected as a migration and a
third state for an admin tool with one user.

The list shows all three states — live, consumed, expired — because "why doesn't this code
work" is the question the operator will actually be answering, and `claimInvite` deliberately
collapses all three into one "invalid or already used" response for the person holding the
code (see the comment on `claimInvite` in `src/lib/invites.ts` for why that collapse is a
feature). The admin is the only party who can tell them apart, which is precisely why this
list has to.

## 6. Deleting a user, and the one table that must survive

Deleting a user removes, in a single transaction, everything scoped to their `orgId`:
`entitlements`, `games`, `disks`, `devices`, `pairing_codes`, `invites`. Then the `auth` rows —
deleting `auth.user` cascades to `auth.member` and, with it, the organization.

**None of the public-schema tables has a foreign key to `organization`.** They are org-scoped
by convention only. So this cascade is written by hand and the ordering is ours to get right;
nothing in the database will catch a missed table. That is why the set is enumerated here.

**`blobs` is never touched.** It is keyed by `sha256` alone, has no `orgId`, and is the
content-addressed dedupe store — the parent spec records that 26+ blobs are already shared
across organizations. Deleting a blob because one tenant's last reference disappeared would
silently corrupt a different tenant's library, turning a cleanup into data loss for someone
who did nothing. Orphaned blobs are a storage cost, not a correctness problem.

Reclaiming them needs reference counting across every org plus deletion from Vercel Blob
storage, and is **backlog** (§8), not part of this plane.

**The confirmation names the blast radius.** Not a generic "are you sure": the dialog states
the organization and the exact counts of games, disks and devices about to be destroyed, and
requires typing the user's email to proceed. This runs against a live database that also
holds real data, and the action is irreversible.

## 7. Verification

**Vitest owns the allowlist parser**, because it is pure and it is the entire security
boundary. Each of these is a test because each is a plausible refactor:

- exact match succeeds; case and surrounding whitespace are insensitive
- **unset or empty denies everyone**
- `sfs@enhance-it.dk.evil.com` is denied (no prefix match)
- `@enhance-it.dk` is denied (no domain match)
- a substring of an allowed address is denied

**Playwright owns everything else** — the pages are async server components and Vitest cannot
render those in this codebase (a constraint recorded since plan 1). The cases that matter: a
signed-in non-admin is redirected from all three routes; **each `/api/admin/*` route rejects a
non-admin independently of the page guard**; an issued code appears in the list; a revoked
code is gone and no longer works at sign-up.

**The cascade-delete test carries the property in §6.** It seeds a throwaway org with games,
disks and a device, deletes it, asserts those rows are gone — **and asserts that a blob shared
with a second org survived**. That last assertion is the one that protects other tenants, and
without it the test would pass against an implementation that deletes blobs.

Like every e2e in this repo it runs against the operator's live database, so it uses
`cleanupSeeded` and operates only on orgs it created.

## 8. Out of scope

**Blob garbage collection** — reclaiming blobs whose last referencing disk is gone. Needs
cross-org reference counting and deletion from Vercel Blob as well as Postgres. Explicitly
backlog, at the operator's direction.

Also excluded: org sharing and multi-user organizations (invites stay pure registration gates,
and the `orgId` `claimInvite` returns stays discarded); impersonation; and an audit log of
admin actions — worth naming because deletions are irreversible and nothing will record who
ran one. Acceptable at one operator; it would not be at two.

---

## What this plan delivered (2026-08-31)

All six tasks shipped on `feat/super-admin`. The plane is at `/admin`: an overview of the
unscoped counts, a paginated user list with a cascade delete, and invite issue/revoke. Identity
is `SUPERADMIN_EMAILS`, read in exactly one file and matched exactly, ASCII-only, on the
pre-lowercase string. Suite at delivery: **256 vitest, 107 Playwright, `pnpm build` clean.**

**Added beyond this spec, at the operator's request:** an `Admin` entry in the app's top nav,
so the operator — who is an ordinary user of webadf as well as its admin — does not have to
remember the URL. It is gated server-side and the allowlist never reaches the client. Hiding a
link is not access control, but it does preserve §1's non-disclosure property: a non-admin is
redirected to `/library` rather than 404'd so the response never confirms `/admin` exists, and a
link rendered for everyone would have leaked it in the markup anyway.

**Also added beyond this spec:** deleting an allowlisted account is refused with a 409. §3's
hazard is that an *unclaimed* allowlisted address is a prize; deleting the row that claims one
would manufacture exactly that, since the allowlist matches on the address and not on a user id.

**Four things in the plan's text were wrong and were corrected in the implementation:**

1. **There is no transaction.** drizzle's neon-http session throws *"No transactions support in
   neon-http driver"*. `db.batch()` — which neon wraps in one server-side transaction — is the
   atomic primitive that exists, so the cascade is built up and submitted as a single batch.
2. **Deleting `auth.user` does not cascade to the organization.** `auth.organization` has no
   foreign key to `auth.user`; the membership cascades and the organization is orphaned. It is
   now deleted explicitly, and only where the deleted user was its last member.
3. **An unauthorized API caller gets a 307, not a 4xx.** This codebase redirects everywhere, and
   Playwright follows redirects by default, so the plan's `[302, 401, 403, 404]` assertion would
   have failed against a correctly working route.
4. **One element cannot carry two `data-testid` values.** The user row carries the countable
   testid plus a `data-email` attribute; the email cell carries the per-email one.

**§8 stands unchanged.** Blob garbage collection is still out of scope and still backlog: the
cascade never touches `blobs`, and the database enforces that independently — `entitlements`
and `disks` both reference `blobs.sha256` with no cascade, so a referenced blob cannot be
deleted even by accident. The absence of an admin audit log also stands, and is now more
pointed than when it was written: deletions are irreversible, they work, and nothing records
who ran one.
