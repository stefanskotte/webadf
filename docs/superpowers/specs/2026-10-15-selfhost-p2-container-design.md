# Self-hosting P2: the container

**Date:** 2026-10-15 · **Status:** design approved in chat (three sections), spec awaiting review

## Where this sits

Docker self-hosting is three sub-projects. P1 (merged 8ff594b, HANDOFF 3bp) made the app run on plain Postgres and
local-disk storage with versioned migrations. **P2 (this spec)** packages it: an image, a compose file, start-up checks,
migrations on start, a scheduler, first-admin bootstrap, CI to GHCR. P3 is feature parity on a fresh install (firmware
import from GitHub, the PaulaNET driver disk, TOSEC/Demozoo/OpenRetro data).

Operator requirements (2026-10-15): persistent Postgres and blob data; upgrades are `docker compose pull && docker
compose up -d` with no user interaction (migrations automatic); prerequisite checks with errors a user can act on.
**Generic:** it must run on vanilla Docker Engine + Compose v2 on any amd64 or arm64 Linux host (and Docker Desktop);
nothing may depend on a particular NAS, distribution or host path. **Developed on the Mac's Docker first** (arm64),
then CI, then the operator's openmediavault box (172.16.10.11, amd64) as acceptance only.

## Decisions

| | Decision |
|---|---|
| D1 | **Image:** `docker/Dockerfile`, multi-stage on `node:24-bookworm-slim`, Next `output: 'standalone'` enabled only when the Docker build sets `WEBADF_STANDALONE=1` (Vercel's build is unchanged). The operational scripts (entrypoint, checks, migrate, backup, bootstrap, scheduler) are bundled with esbuild into plain JS in the image; no `tsx` at runtime. `drizzle/` is copied in. Runs as a non-root user (uid 1000). `GIT_SHA` build arg feeds the About page (already supported). `SELFHOSTED` is not set, so the About page says Self-hosted. |
| D2 | **Compose** (`compose.yaml` + `.env.example` at the repo root), five services on one internal network: `setup` (one-shot, the app image: checks host-side facts and creates secrets), `db` (`postgres:18`), `app`, `scheduler` (the app image, command `scheduler`), `caddy` (`caddy:2`). `db`, `app` and `scheduler` publish nothing; only `caddy` publishes `${WEBADF_HTTPS_PORT:-443}:443`. Healthchecks: `db` `pg_isready`; `app` a new `GET /api/health` (DB ping, no auth, no details). Ordering via `depends_on` conditions (`service_completed_successfully`, `service_healthy`). |
| D3 | **Configuration:** required in `.env`: `WEBADF_URL` (the https address people open, e.g. `https://192.168.1.10` or `https://amiga.lan:8443`) **or** `WEBADF_DOMAIN` (a public DNS name; implies `https://<domain>` and Let's Encrypt), and `WEBADF_ADMIN_EMAIL`. Optional: `WEBADF_DATA_DIR` (default `./data`), `WEBADF_HTTPS_PORT` (default 443), `WEBADF_IMAGE_TAG` (default `latest`). The app derives `BETTER_AUTH_URL` from them; `SUPERADMIN_EMAILS` defaults to `WEBADF_ADMIN_EMAIL` (overridable). **No secrets in `.env`.** |
| D4 | **Secrets are generated, never typed:** `setup` writes `BETTER_AUTH_SECRET`, `CRON_SECRET` and the Postgres password (32 random bytes, base64url) to `$WEBADF_DATA_DIR/secrets/` (mode 0600, owned by uid 1000) **only when absent**. `db` reads `POSTGRES_PASSWORD_FILE`; `app`/`scheduler` read the files at start. An existing but empty file is an error, never regenerated (regenerating would log everyone out and lock out the database). |
| D5 | **One data folder (bind mount):** `$WEBADF_DATA_DIR/{postgres,blobs,caddy,secrets,backups}`. One folder to back up or move to another disk. `STORAGE_DIR=/data/blobs` in the container (P1's local backend; `BLOB_READ_WRITE_TOKEN` is never set). |
| D6 | **TLS by Caddy on one port:** without `WEBADF_DOMAIN`, `tls internal` with on-demand certificates (so an IP address or LAN name works); boards connect with `wf server <host>[:port]` + `wf server tls noverify` (fw 1.13.0); browsers warn until the user trusts Caddy's root (`data/caddy/pki/authorities/local/root.crt`, documented). With `WEBADF_DOMAIN`, Let's Encrypt via TLS-ALPN-01 on 443 -- port 80 is never published (it is often taken, e.g. by a NAS's own web UI). Plain HTTP is not offered. |
| D7 | **Start-up checks** (`setup` for host-side facts, `app` again before anything else): each failure prints one line -- what is wrong and the command or setting that fixes it -- and exits non-zero. URL/domain present, https, consistent; admin email well-formed; every data subfolder writable by uid 1000 (message gives the `chown` command); free space (fail < 1 GB, warn < 5 GB); secrets files present and non-empty; database reachable within 60 s and the password accepted (message names a data folder created by another install as the likely cause); `data/postgres/PG_VERSION` equals the image's major (a major upgrade is never automatic; message points at the docs). |
| D8 | **Origin mismatch at runtime** (P1 deferred item): a request whose `Host` differs from `WEBADF_URL`'s logs one warning per distinct host: requests arrive as X, `WEBADF_URL` is Y, uploads and sign-in will fail, fix `WEBADF_URL`. |
| D9 | **Safe automatic migrations** (in `app`'s entrypoint, after checks): take a Postgres advisory lock; if migrations are pending, `pg_dump -Fc` into `data/backups/<timestamp>-before-<first pending>.dump` first (keep the newest 5; skip when nothing is pending); apply with P1's migrator (one transaction); on failure exit naming the migration, the error and the backup path (the schema stays as it was). If the database's journal holds a migration this image does not know, refuse to start ("database is at 0042, this image knows up to 0040 -- use a newer image"). `pg_dump` 18 is installed in the image. |
| D10 | **First-admin bootstrap:** after migrations, if `auth.user` is empty, ensure exactly one unexpired bootstrap invite exists (created by `system`; an invite's org is unused at sign-up -- every new user gets their own organization) and log `Sign up as the first admin: <WEBADF_URL>/sign-up?invite=<code>` on every start until a user exists. The sign-up page prefills the code from `?invite=`. Super-admin rights come from `SUPERADMIN_EMAILS` (D3), so the admin must sign up with `WEBADF_ADMIN_EMAIL`; the log line says so. |
| D11 | **Scheduler sidecar:** `scheduler` runs a loop that calls `POST`/`GET` (whatever the routes take today) `http://app:3000/api/cron/{scan,demozoo,blob-gc}` with `Authorization: Bearer $CRON_SECRET` on the schedules now in `vercel.ts`. The schedules move to one shared module that `vercel.ts` and the scheduler both import, so they cannot drift. Each run logs start, HTTP status and duration; a failed run is logged and retried at the next slot (the jobs are resumable). Cron expressions are UTC. |
| D12 | **CI** (`.github/workflows/image.yml`): on every push to master, build amd64 and arm64 natively in parallel (GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm`), run the compose smoke test (D13) on amd64 with the new image, and only then push a multi-arch manifest to `ghcr.io/stefanskotte/webadf` tagged `edge` and `sha-<short>`. A `web-X.Y.Z` git tag retags that commit's image as `X.Y.Z` and `latest` (no rebuild). The compose file uses `${WEBADF_IMAGE_TAG:-latest}`. The first `web-1.0.0` tag is the operator's call after OMV acceptance. |
| D13 | **Upgrades are `pull && up -d`:** no step needs input; secrets, data and Caddy state persist in the data folder; the image is the only thing that changes. |

## Testing

- **Unit (vitest):** the check functions and their exact messages; URL/domain resolution; the shared schedule module (and that `vercel.ts` uses it); backup naming and retention; the origin-mismatch warn-once logic.
- **db tests (`pnpm test:db`):** bootstrap is idempotent (one invite while no user exists, none created once one does); two concurrent migrators serialise on the advisory lock; the newer-database refusal.
- **`scripts/docker-smoke.sh`** (run on the Mac first, then in CI): build the image, fresh data folder, `compose up -d`, wait healthy, find the first-admin line in the log, `curl -k` `/api/health` through Caddy, `up -d` again (no migration applied, no new backup, data intact). Failure cases, each must exit with its message: no `WEBADF_URL`, unwritable data folder, newer database.
- **Selected e2e specs against the running stack** (sign-up with the invite, upload, files page, device pairing/mount via the device API), using a compose override that publishes the db port for the test run only.
- **Mac acceptance:** the whole flow in a browser against `https://localhost:<port>`.
- **OMV acceptance (operator-gated):** install from the `edge` image with the data folder on a `/srv` disk; sign up via the logged link; upload a disk; point the bench board at it (`wf server 172.16.10.11` + `wf server tls noverify`) and mount -- the board reports it in the drive; then `pull && up -d` to a newer `edge`: data intact, a backup taken only if a migration was pending, the board still connected. Pointing the board back at webadf.vercel.app afterwards is part of the step.

## Documentation

`docs/self-hosting.md`: requirements, install (copy `compose.yaml` + `.env.example`, two settings, `up -d`, read the sign-up line), trusting the internal CA, board setup, upgrade, backup and restore (the data folder; restoring a dump), Postgres major upgrade (manual, documented), troubleshooting (each check's message). README links to it.

## Not in scope

Firmware import, PaulaNET disk, catalogue data (P3); email delivery; plain-HTTP serving; multi-node, Swarm or Kubernetes; automatic Postgres major upgrades; moving our deployment off Vercel.
