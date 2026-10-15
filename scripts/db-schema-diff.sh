#!/usr/bin/env bash
# Schema-only diff of two databases (public + auth), journal excluded. Exit 0 = identical.
# Both sides are dumped by the webadf-pg container's own pg_dump 18, so a URL
# for the local database must be reachable from INSIDE the container
# (postgresql://postgres:webadf@localhost:5432/webadf).
# Only public + auth are compared: they are the schemas drizzle/ owns. Left out
# on purpose (Neon noise, not drift): neon_auth (Neon Auth's provisioned tables,
# nothing in this repo references them), extensions (pg_dump -n skips them;
# pg_trgm's indexes and opclass uses ARE compared), roles/grants
# (--no-owner --no-privileges), and the drizzle schema (migration journal;
# production has none until db:baseline --apply).
set -euo pipefail
dump() {
  docker exec webadf-pg pg_dump --schema-only --no-owner --no-privileges --no-comments \
    -n public -n auth "$1" \
  | grep -vE '^(--|SET |SELECT pg_catalog\.set_config|\\(un)?restrict )' | sed '/^$/d'
}
diff -u <(dump "$1") <(dump "$2")
