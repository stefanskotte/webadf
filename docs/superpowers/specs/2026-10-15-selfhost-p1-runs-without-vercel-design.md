# Self-hosting P1: the app runs without Vercel or Neon

**Date:** 2026-10-15 · **Status:** design approved in chat, spec awaiting review

## Where this sits

Docker self-hosting (operator, 2026-10-15) is three sub-projects, each with its own spec, plan and merge:

- **P1 (this spec):** the app runs on plain PostgreSQL and local-disk file storage, with versioned migrations.
  Production keeps working on Neon and Vercel Blob throughout.
- **P2:** the container: Dockerfile, a compose file (Postgres, app, Caddy), start-up prerequisite checks with
  fixable messages, migrations on start, an in-stack scheduler, first-admin bootstrap, multi-arch image on GHCR,
  tested on the operator's openmediavault box. Vanilla Docker and Compose only, nothing host-specific.
- **P3:** feature parity on a fresh install: firmware releases imported from GitHub, the PaulaNET driver disk,
  TOSEC/Demozoo/OpenRetro data.

The operator's requirements for the whole: persistent PostgreSQL and blob data; upgrades are `docker compose pull
&& docker compose up -d` with no user interaction (migrations run automatically); prerequisite checks with actionable
errors. P1 makes the second requirement possible (real migrations) and the first (a local blob backend).

## What blocks self-hosting today (inventory, 2026-10-15)

1. `src/db/index.ts` builds the database on `drizzle-orm/neon-http` + `@neondatabase/serverless`, which speaks only
   Neon's HTTP protocol. 10 `db.batch()` call sites in 7 files rely on it (no interactive transactions on neon-http).
2. Production's schema was built with `drizzle-kit push` plus hand-run SQL; there is no `__drizzle_migrations`
   journal, so `drizzle/0000`-`0038` have never been replayed anywhere.
3. `src/lib/storage.ts` is the only `@vercel/blob` user (five stores, all private). Browser and CLI uploads PUT
   straight to a Vercel Blob presigned URL (`/api/ingest/presign` -> `dropzone.tsx`, `cli/src/index.ts`).

Everything else (crons, standalone output, TLS, env) is P2. The board never talks to blob storage.

## Decisions

| | Decision |
|---|---|
| D1 | **One driver everywhere: `pg` + `drizzle-orm/node-postgres`.** Our deployment uses Neon's pooled URL (it already does: `-pooler`); a self-host uses its own Postgres. On Vercel the pool is registered with `attachDatabasePool` (`@vercel/functions`) so idle clients close before an instance suspends. Pool size small (max 5) because Neon's pooler does the real pooling. Rejected: neon-http on Vercel and `pg` elsewhere -- two code paths with different transaction semantics, only one tested on any day. |
| D2 | **`db.batch()` becomes `db.transaction()`** at all 10 call sites, keeping all-or-nothing. Where a caller reads batch results (`admin-delete.ts:130`), the transaction returns the same values. `NeonHttpDatabase` types become the node-postgres type (or a small `Db` alias in `src/db`). |
| D3 | **Versioned migrations.** Replay `drizzle/0000`-`0038` into an empty Postgres 18 (Docker on the Mac) and diff `pg_dump --schema-only` (normalised) against production's. Every difference becomes one catch-up migration `0039` (or a fix to an earlier file when it can never have run as written), until a fresh database and production are schema-identical except for the journal. |
| D4 | **Production is marked up to date, once.** After D3, `__drizzle_migrations` is created in production with every migration recorded as applied (hash + created_at, exactly as drizzle's migrator writes them). It adds a table and changes nothing else. Done by a script with a dry-run that prints the rows first; **the operator approves the real run.** |
| D5 | **`pnpm db:migrate`** (drizzle's node-postgres migrator) replaces `db:push` for every database, ours included. New schema changes are `drizzle-kit generate` files. Production migrations stay a deliberate manual step in P1; P2 runs them on container start. `db:push` is removed from `package.json` so it cannot drop the trigram indexes again. |
| D6 | **A storage backend interface** in `src/lib/storage/`: `put(key, body, {overwrite, contentType})`, `read(key)`, `readStream(key)` (with size), `head(key)`, `del(key)`, `list(prefix)` (paged), plus `uploadUrl(key, {maxBytes, ttl})`. Two implementations: **`vercel-blob`** (today's code moved behind it, behaviour unchanged) and **`local`**. The five stores (`diskStore`, `imageStore`, `coverStore`, `demozooExportStore`, `firmwareStore`) keep their public APIs and sit on whichever backend is active. |
| D7 | **Backend selection without configuration:** `vercel-blob` when `BLOB_READ_WRITE_TOKEN` is set, otherwise `local` (same principle as `SELFHOSTED`: a self-hoster sets nothing). `STORAGE_DIR` (default `./data/blobs`; P2 sets `/data/blobs`) is where `local` writes. `STORAGE_BACKEND` on the About page reports the active one. |
| D8 | **The local backend writes safely:** temp file in the same directory + `fsync` + `rename`, so a crash never leaves a half file under a real key; `put` without overwrite fails with the same "already exists" error class the callers already handle (`isBlobAlreadyExists`); keys are validated (`[a-z0-9/._-]`, no `..`, no leading `/`) and resolved under `STORAGE_DIR`, refusing anything that escapes it. |
| D9 | **Uploads on the local backend go through the app:** `uploadUrl` returns `/api/blob-upload/<key>?exp=<unix>&max=<bytes>&sig=<hmac>` with an HMAC-SHA256 over key, exp and max, keyed by a key derived from `BETTER_AUTH_SECRET` (HKDF, label `webadf-blob-upload`). The PUT route streams to the backend, refuses a body over `max` (413) and an expired or bad signature (403, so `isExpiredPresign` and the dropzone's one retry keep working), and answers "already exists" exactly as Vercel Blob does. The dropzone and the CLI do not change. `/api/ingest/complete` still verifies the digest after upload. |
| D10 | **No data moves.** Production stays on Vercel Blob; nothing is copied. |
| D11 | **Everything is developed and proven on the Mac's Docker.** The openmediavault box is for P2. |

## Testing

- **vitest:** one backend contract suite run against `local` (in a temp dir) and an in-memory fake: put/no-overwrite,
  overwrite, read, stream with size, head of a missing key, delete, list paging, key validation (traversal refused),
  crash-safety (no file under the key until rename). The upload route: good signature, expired (403), tampered key or
  max (403), over-size body (413, nothing stored), duplicate (already-exists), then `/api/ingest/complete` accepts it.
- **Migrations:** a script `scripts/db-schema-diff.ts` that migrates a throwaway database and diffs it against a
  target, used for D3 and kept for future checks.
- **e2e, twice, before merge:** (1) as today, against Neon + Vercel Blob, the full suite -- this proves the driver
  change against production's data and services; (2) fully local: a Postgres 18 container on the Mac migrated from
  zero with `pnpm db:migrate`, local storage, the full suite on `PORT=3100`. Any spec that depends on production-only
  data is listed and either seeded or skipped with a reason in the plan, never silently.
- **Preview deployment** on Vercel with the new driver, smoke-checked (sign in, library, upload a disk, mount
  from the bench board), before the merge to master.

## Rollout

1. D3 diff and catch-up migration on the branch.
2. Operator approves; D4 journal written to production.
3. e2e both ways; preview deployment checked.
4. Merge (deploys production on `pg`). Watch runtime errors for the first hour.

Rollback: revert the merge. The journal table (D4) is inert for the old code.

## Not in scope

Dockerfile, compose, Caddy, scheduler, start-up checks, first-admin bootstrap, GHCR (P2); firmware import, PaulaNET
disk, catalogue data (P3); moving production off Neon or Vercel Blob; making e2e default to the local database
(possible afterwards, a separate decision).
