#!/usr/bin/env bash
# Runs selected e2e specs against a fresh compose stack (image from docker-smoke's build, or $WEBADF_SMOKE_IMAGE).
# The specs write fixtures straight to the database, so DATABASE_URL points at the stack's own db (published on
# loopback by compose.e2e.yaml) and BLOB_READ_WRITE_TOKEN is empty: nothing here may reach production.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${WEBADF_E2E_PORT:-8443}"; DBP="${WEBADF_E2E_DB_PORT:-55435}"
IMAGE="${WEBADF_SMOKE_IMAGE:-webadf:smoke}"
# pwd -P: on macOS $TMPDIR is under the /var -> /private/var symlink, and Docker Desktop shares /private, not /var.
W=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/webadf-e2e.XXXXXX")" && pwd -P)
cp compose.yaml compose.e2e.yaml "$W/"
printf 'WEBADF_URL=https://localhost:%s\nWEBADF_ADMIN_EMAIL=e2e-admin@example.org\nWEBADF_HTTPS_PORT=%s\nWEBADF_IMAGE_TAG=e2e-local\n' "$PORT" "$PORT" > "$W/.env"
export WEBADF_E2E_DB_PORT="$DBP"
dc() { docker compose -p webadf-e2e --project-directory "$W" -f "$W/compose.yaml" -f "$W/compose.e2e.yaml" "$@"; }
docker tag "$IMAGE" ghcr.io/stefanskotte/webadf:e2e-local
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker run --rm -v "$W:/w" alpine rm -rf /w/data >/dev/null 2>&1 || true
  rm -rf "$W"
  docker rmi ghcr.io/stefanskotte/webadf:e2e-local >/dev/null 2>&1 || true
}
trap cleanup EXIT
dc up -d --wait
PW=$(docker run --rm -v "$W/data/secrets:/s:ro" alpine cat /s/pg_password)
export DATABASE_URL="postgresql://webadf:$PW@127.0.0.1:$DBP/webadf" BASE_URL="https://localhost:$PORT" \
  E2E_IGNORE_HTTPS=1 NODE_TLS_REJECT_UNAUTHORIZED=0 E2E_SIGNUP_GAP_MS=3500 E2E_LOCAL=1 BLOB_READ_WRITE_TOKEN=""
[ $# -gt 0 ] || set -- e2e/auth.spec.ts e2e/invite.spec.ts e2e/ingest-ui.spec.ts e2e/library-mount.spec.ts e2e/device-protocol.spec.ts
# On failure, show what the stack saw (the app's log is where a refused sign-up or a wrong origin shows up).
pnpm exec playwright test "$@" || { rc=$?; echo "--- app log (last 40 lines) ---" >&2; dc logs --no-color --tail 40 app >&2; exit "$rc"; }
