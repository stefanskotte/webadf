#!/usr/bin/env bash
# e2e with NO Vercel or Neon (self-hosting P1): a fresh Postgres 18 migrated from
# zero, local-disk storage in a temp dir. Arguments go to playwright.
#
# Every variable below is EXPORTED, and exported wins everywhere .env.local is
# read: e2e/helpers.ts loads .env.local only for keys not already in the
# environment (an empty string counts as set), Playwright's webServer passes the
# runner's whole environment to `next dev`, and Next never lets a .env file
# overwrite a variable already set. So the database and storage here are the
# only ones this run can reach -- even with production's .env.local in place.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3100}"
# reuseExistingServer is on in playwright.config.ts: a server already on this
# port (another run's, against production) would be silently reused. Refuse.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "e2e-local: something already listens on :$PORT -- refusing to reuse it" >&2
  exit 1
fi
URL=$(bash scripts/dev-db.sh start)
bash scripts/dev-db.sh reset >/dev/null
# mktemp with an explicit template: BSD (macOS) and GNU (Linux) agree on this form.
export DATABASE_URL="$URL" BLOB_READ_WRITE_TOKEN="" STORAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webadf-e2e-blobs.XXXXXX")"
export PORT BETTER_AUTH_URL="http://localhost:${PORT}" E2E_LOCAL=1
pnpm exec tsx scripts/db-migrate.ts
exec pnpm exec playwright test "$@"
