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
# Another name for this host (SNI and Host other.test) still reaches the app, which logs once that it is not WEBADF_URL.
curl -skf --resolve "other.test:$PORT:127.0.0.1" "https://other.test:$PORT/api/health" | grep -q ok || fail "a host other than WEBADF_URL did not reach the app"
curl -sk -o /dev/null --resolve "other.test:$PORT:127.0.0.1" "https://other.test:$PORT/api/auth/get-session" || fail "/api/auth by another host name"
has "requests arrive as https://other.test:$PORT but WEBADF_URL is https://localhost:$PORT" "$(dc logs app 2>&1)" || fail "no origin warning for another host name"
echo "smoke: other host name OK"

# Recreate every container (what `pull && up -d` does to a new image): secrets, data and the Caddyfile must survive.
psql() { dc exec -T db psql -U webadf -d webadf -tAc "$1"; }
secrets_sum() { docker run --rm -v "$W/data/secrets:/s:ro" alpine sh -c 'cd /s && sha256sum better_auth_secret cron_secret pg_password'; }
before=$(secrets_sum)
psql "insert into invites (code, org_id, created_by_user_id, expires_at) values ('SMOKEMRK', 'smoke', 'smoke', now() + interval '1 day')" >/dev/null
# Through a container: setup (root) owns data/caddy, so a non-root host user cannot append to it on Linux.
docker run --rm -v "$W/data/caddy:/c" alpine sh -c "echo '# stale' >> /c/Caddyfile"
dc up -d --force-recreate --wait || fail "stack did not come back after a recreate"
[ "$(secrets_sum)" = "$before" ] || fail "secrets changed across a recreate"
[ "$(psql "select count(*) from invites where code = 'SMOKEMRK'")" = 1 ] || fail "a row written before the recreate is gone"
! grep -q '# stale' "$W/data/caddy/Caddyfile" || fail "setup did not re-render the Caddyfile"
has "migrations: up to date" "$(dc logs app 2>&1)" || fail "the recreate was not a no-op"
[ -d "$W/data/backups" ] || fail "data/backups was not created"
[ -z "$(ls "$W/data/backups")" ] || fail "a backup was taken with nothing pending"
[ -e "$W/data/backups/.last-start" ] || fail "no start marker (backups/.last-start) after a successful start"
echo "smoke: first start + recreate OK"

# D5: first start stored the image's sha-pinned PaulaNET disk (the local backend keeps it at blobs/adf/<sha>).
# The download route needs a session, so look at the store; size and digest must be the pinned ones.
pn_sha=$(sed -n "s/.*PAULANET_DISK_SHA256 = '\([0-9a-f]\{64\}\)'.*/\1/p" src/lib/paulanet-disk.ts)
[ -n "$pn_sha" ] || fail "could not read PAULANET_DISK_SHA256 from src/lib/paulanet-disk.ts"
got=$(docker run --rm -v "$W/data/blobs:/b:ro" alpine sh -c "sha256sum /b/adf/$pn_sha | cut -d' ' -f1" 2>&1) || true
[ "$got" = "$pn_sha" ] || fail "the PaulaNET disk is not stored under its sha in blobs/adf (got: $got)"
echo "smoke: PaulaNET disk OK"

# Change WEBADF_URL to an IP address: `up -d` alone must bring Caddy onto the new site (it is not recreated;
# it reloads the re-rendered Caddyfile), and a client that sends no SNI (curl to an IP) must get the certificate.
caddy_id=$(dc ps -q caddy)
sed -i.bak "s|^WEBADF_URL=.*|WEBADF_URL=https://127.0.0.1:$PORT|" "$W/.env" && rm -f "$W/.env.bak"
dc up -d --wait || fail "stack did not come back after changing WEBADF_URL"
ok=""
for _ in $(seq 1 20); do
  if curl -skf "https://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q ok; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "https://127.0.0.1:$PORT/api/health did not answer after changing WEBADF_URL"
[ "$(dc ps -q caddy)" = "$caddy_id" ] || fail "caddy was recreated: the new site came from the recreate, not from --watch reloading the Caddyfile"
echo "smoke: IP address URL OK"

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
