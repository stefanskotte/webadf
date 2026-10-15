#!/usr/bin/env bash
# A throwaway Postgres 18 for tests and the local e2e run (self-hosting P1).
# Only ever touches the container it names.
set -euo pipefail
# Overridable so a second, disposable database (the e2e run, scripts/e2e-local.sh)
# never touches the developer's: the defaults are the dev container.
NAME="${WEBADF_PG_NAME:-webadf-pg}" PORT="${WEBADF_PG_PORT:-55432}"
URL="postgresql://postgres:webadf@127.0.0.1:${PORT}/webadf"
case "${1:-}" in
  start)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" -e POSTGRES_PASSWORD=webadf -e POSTGRES_DB=webadf -p "${PORT}:5432" postgres:18 >/dev/null
    fi
    for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -d webadf >/dev/null 2>&1 && break; sleep 1; done
    echo "$URL" ;;
  reset)  # drop and recreate the database, keeping the container
    docker exec "$NAME" psql -U postgres -c 'drop database if exists webadf with (force)' -c 'create database webadf' >/dev/null
    echo "$URL" ;;
  stop) docker rm -f "$NAME" >/dev/null ;;
  url) echo "$URL" ;;
  psql) shift; docker exec -i "$NAME" psql -U postgres -d webadf "$@" ;;
  *) echo "usage: $0 start|reset|stop|url|psql" >&2; exit 2 ;;
esac
