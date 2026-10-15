#!/usr/bin/env bash
# Builds the image (or uses $WEBADF_SMOKE_IMAGE), runs a fresh stack in a temp folder, proves first start,
# a no-op restart, a real pg_dump from the image, and three refusals. Generic: needs only docker + compose v2 + curl.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${WEBADF_SMOKE_IMAGE:-webadf:smoke}"
PORT="${WEBADF_SMOKE_PORT:-8443}"
[ -n "${WEBADF_SMOKE_IMAGE:-}" ] || docker build -f docker/Dockerfile -t "$IMAGE" --build-arg GIT_SHA="$(git rev-parse HEAD)" .
# pwd -P: on macOS $TMPDIR is under the /var -> /private/var symlink, and Docker Desktop shares /private, not /var.
W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/webadf-smoke.XXXXXX")" && pwd -P)
cp compose.yaml "$W/"
cat > "$W/.env" <<EOF
WEBADF_URL=https://localhost:$PORT
WEBADF_ADMIN_EMAIL=smoke@example.org
WEBADF_HTTPS_PORT=$PORT
EOF
dc() { docker compose -p webadf-smoke --project-directory "$W" -f "$W/compose.yaml" "$@"; }
# compose.yaml names ghcr.io/stefanskotte/webadf:${WEBADF_IMAGE_TAG}; point a throwaway tag at the image under test.
export WEBADF_IMAGE_TAG=smoke-local
docker tag "$IMAGE" "ghcr.io/stefanskotte/webadf:$WEBADF_IMAGE_TAG"
ROOT_VOL=webadf-smoke-rootblobs
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  # data/ holds files owned by the containers' uids; remove them from a container.
  docker run --rm -v "$W:/w" alpine rm -rf /w/data /w/data-old >/dev/null 2>&1 || true
  rm -rf "$W"
  docker volume rm "$ROOT_VOL" >/dev/null 2>&1 || true
  docker rmi "ghcr.io/stefanskotte/webadf:$WEBADF_IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "SMOKE FAIL: $*" >&2; dc logs --no-color 2>&1 | tail -40 >&2; exit 1; }
# Output into a variable first: `cmd | grep -q` under pipefail fails when grep closes the pipe early (SIGPIPE)
# or when cmd itself exits non-zero, which every refusal does on purpose.
has() { grep -qF -- "$1" <<<"$2"; }

dc up -d --wait || fail "stack did not become healthy"
logs=$(dc logs app 2>&1)
has "Sign up as the first admin (use smoke@example.org): https://localhost:$PORT/sign-up?invite=" "$logs" || fail "no first-admin line"
has "migrations: applied" "$logs" || fail "first start applied no migrations"
curl -skf "https://localhost:$PORT/api/health" | grep -q ok || fail "/api/health through caddy"
dc restart app && dc up -d --wait || fail "stack did not come back after a restart"
[ "$(dc logs app 2>&1 | grep -c 'migrations: up to date')" -ge 1 ] || fail "restart was not a no-op"
[ -d "$W/data/backups" ] || fail "data/backups was not created"
[ -z "$(ls -A "$W/data/backups")" ] || fail "a backup was taken with nothing pending"
echo "smoke: first start + restart OK"

# The image's pg_dump against the stack's db, connected the way migrate.ts connects (PG* env, no password in argv).
v=$(dc exec -T app pg_dump --version)
has "(PostgreSQL) 18." "$v" || fail "pg_dump in the image is not 18: $v"
dc exec -T app node -e '
  const { execFileSync } = require("node:child_process");
  const { readFileSync, statSync } = require("node:fs");
  const env = { ...process.env, PGHOST: "db", PGPORT: "5432", PGUSER: "webadf", PGDATABASE: "webadf",
    PGPASSWORD: readFileSync("/data/secrets/pg_password", "utf8").trim() };
  execFileSync("pg_dump", ["--format=custom", "--file=/tmp/smoke.dump"], { env, stdio: "inherit" });
  const n = statSync("/tmp/smoke.dump").size;
  if (n === 0) process.exit(1);
  console.log(`pg_dump wrote ${n} bytes`);
' || fail "pg_dump from the image failed"
[ "$(dc exec -T app pg_restore --list /tmp/smoke.dump | grep -c ' TABLE ')" -ge 10 ] || fail "the dump does not list the tables"
echo "smoke: pg_dump OK"

# Refusals (each must exit 1 with its message)
dc down
sed -i.bak 's/^WEBADF_URL=.*/WEBADF_URL=/' "$W/.env"
out=$(dc run --rm setup 2>&1 || true)
has 'Set WEBADF_URL in .env' "$out" || fail "missing WEBADF_URL not refused: $out"
mv "$W/.env.bak" "$W/.env"
# A data folder whose postgres/ holds only an older major (the live one holds 18/, which is never refused).
mkdir -p "$W/data-old/postgres/17"
out=$(WEBADF_DATA_DIR="$W/data-old" dc run --rm setup 2>&1 || true)
has 'holds a Postgres 17 cluster' "$out" || fail "old Postgres major not refused: $out"
# A root-owned blobs folder. A named volume, because Docker Desktop's bind mounts (macOS, Windows) do not
# enforce container-side ownership; a volume does, on every host.
docker volume create "$ROOT_VOL" >/dev/null
docker run --rm -v "$ROOT_VOL:/v" alpine sh -c 'chown 0:0 /v && chmod 755 /v'
out=$(dc run --rm --no-deps -v "$ROOT_VOL:/data/blobs" app start 2>&1 || true)
has 'blobs is not writable by uid 1000' "$out" || fail "unwritable blobs not refused: $out"
echo "smoke: refusals OK"
