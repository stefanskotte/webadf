# webadf — Decision Log (foundation & library)

Rulings taken during implementation of
`docs/superpowers/plans/2026-08-24-webadf-foundation-library.md`.
Preserved here because they are not otherwise recoverable from git history.

- Ruling: feature branch, not a separate git worktree — Task 1 runs `vercel link`
- Ruling: provisioning (gh repo create, vercel link/integration/blob, prod deploy)
- | T1 | T10 | src/app/globals.css, src/app/layout.tsx | **CONFLICT — see Ruling PF-1** |
- | T3 | **CONFLICT — see Ruling PF-2** (eager getDb() at module scope). Also: auth.ts (step 2) imports `member` from a file generated in step 3 — sequential steps resolve it. |
- ### Rulings
- Ruling PF-1 (T1 vs T10, font variable): T1 patches shadcn's `--font-sans:
- Ruling PF-2 (T3, eager getDb()): `drizzleAdapter(getDb(), ...)` at module scope
- as written is expected to build. Ruling: keep it, but T3 step 9 (`pnpm build`) is
- Ruling T1-1: the implementer created the Blob store with `--access public`.
- Ruling T1-2: `vercel env pull` overwrites .env.local wholesale, which silently
- Ruling T2-1: PLAN DEFECT, authored by me. The Task 2 test asserts on
- Ruling PF-2 RESOLVED: eager `getDb()` inside `drizzleAdapter(getDb(), ...)` at
- Task 3 review: spec ✅, quality "needs work" — 3 Important, 6 Minor. Rulings:
- Ruling T3-2 (Important #1, ACCEPT — PLAN DEFECT I AUTHORED): a throwing
- Ruling T3-3 (Important #2, ACCEPT IN PART): `.limit(1)` with no `orderBy` picks
- Ruling T3-4 (Important #3, ACCEPT then DEFER): BETTER_AUTH_SECRET is set for
- MAJOR CORRECTION — Ruling T3-5: the plan's two-hook design NEVER WORKED, and the
- Ruling T4-1 (Important, ACCEPT — PLAN DEFECT I AUTHORED): e2e test 3 is named
- Ruling T4-2: the fix must anchor on a STABLE test id, not the current
- Ruling T5-1 (ACCEPT, carried into Task 6): the corpus run found that the
- Ruling T6-1 (ACCEPT — MY INSTRUCTION WAS SELF-CONTRADICTORY): the implementer
- Ruling T8-1 (ACCEPT — PLAN DEFECT I AUTHORED): /complete is NOT idempotent for
- Ruling T9-1: my brief said the archive holds 61 files; it holds 62 (61 .adf + 1 .dms).
- Ruling T9-2: my brief said to EXTEND pnpm-workspace.yaml's `packages:` list; the file
- Ruling T9-3: root tsconfig.json needed `cli` excluded or `next build`'s typecheck broke
- Ruling T10-1: PF-1 comes due here. Task 1 patched shadcn's self-referencing
- Ruling T10-2 (NEW, caught composing the dispatch): Task 10 adds <SignOutButton/> to
- Ruling T10-3 (ANOTHER PLAN DEFECT I AUTHORED): my brief put next/font's variable
- Rulings T10-1 (font bridge) and T10-2 (duplicate SignOutButton) both handled.
- Ruling T11-1 (NEW): my Task 11 plan text replaces library/page.tsx wholesale and the
- Ruling T11-1 handled: sr-only span carries data-testid="active-org".
-     the `_#N` MISC31/TOOLS31/... family). Expected per Ruling T6 (differently
- Ruling T11-2 (Important, ACCEPT): the disks leftJoin carries no orgId predicate; only the
- Ruling T11-3 (Important, ACCEPT — MY BRIEF AGAIN): the two-org isolation e2e test asserts
- Ruling T12-1 (Medium, ACCEPT): e2e/view-toggle.spec.ts asserts only the URL and the
- Ruling T13-1 (TWO MORE PLAN DEFECTS I AUTHORED, both fixed): my brief's dropzone code
- Task 13 review: spec ❌ (1 Critical), quality "needs work". Rulings:
- Ruling T13-2 (CRITICAL, ACCEPT — PLAN DEFECT I AUTHORED, #9): the dropzone sends the
- Ruling T13-3 (Medium, ACCEPT): an unhandled fetch rejection on a network-level PUT
- Ruling T13-4 (pre-existing shell bug, FIX ANYWAY): SignOutButton uses shadcn's ghost
- Ruling F-1 (C1, MUST FIX): content addressing is unenforced — nothing compares uploaded
- Ruling F-2 (I1, SPEC CONTRADICTION — operator decision required, NOT fixed in this wave):
- Ruling F-3: fixing in this wave — C1(a) size+digest verification, C1(b) unwedge,
- Ruling F-4: the dropzone ignores /complete's rejected/rejectedReasons, so a partially
- Ruling F-5: cli/src/index.ts increments `completed` before subtracting `rejected`, so the
- Ruling F-6: gzipSync blocks the event loop ~15-20ms per blob; a 500-entirely-new batch is
- Ruling F-7: verify() does not re-check stat.sizeBytes against MAX_DISK_BYTES before

## Deferred minor findings (triaged at final review)

### Fix before merge to main
- Preview `BETTER_AUTH_SECRET` is unset (Vercel CLI 54.5.1 bug blocked it). Preview deploys will 500 at boot.

### Carry hard into plan 2 (device plane)
- **7 games currently have zero boot disks** (verified live). `groupDisks` does not guarantee exactly one `isBoot` per game — a set with disks 2 and 3 and no disk 1 gets none. The mount flow must not assume one exists.
- `/api/ingest/check` is a global cross-tenant existence oracle and an entitlement is granted on hash knowledge alone. Nothing leaks today because no download route exists; **plan 2's `/api/device/poll` must not ship until this is settled** (see Ruling F-2).

### Follow-up, non-blocking
- Dropzone ignores `/complete`'s `rejectedReasons` (Ruling F-4) — most worthwhile of these.
- CLI "N catalogued" over-counts rejected files (F-5).
- `gzipSync` blocks the event loop; async `zlib.gzip` would overlap it with read-backs (F-6).
- `verify()` lacks a defence-in-depth size guard before read-back (F-7).
- No FK from `org_id` to `auth.organization.id`; org deletion would strand catalog rows.
- `orgFilter` has one call site; spec §5's `db.forOrg` type-level guarantee is not achieved.
- No `db:migrate` script — migrations are generated but only applied by manual `db:push`.
- Chunk-wiring and network-abort paths untested (acknowledged coverage gaps).
- Parser edge cases for the review queue in plan 3: `ICDPrepHD-42`, `(1995-03-30)` losing year+publisher, nested-paren publishers.
- Hardcoded hex colours in 4 components, against spec §11.1.
- Playwright traces capture `/presign` bodies (live 1h credentials); gitignored, but do not share a trace.
