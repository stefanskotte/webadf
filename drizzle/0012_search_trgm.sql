-- Infix search (D-5-2): ILIKE '%foo%' cannot use games_org_sort_idx, which is
-- a btree on (org_id, sort_title). A GIN trigram index can.
--
-- HONEST NOTE (spec section 5): at the current size -- 9 games, and 61 disks in
-- the operator's full archive -- Postgres will very likely choose a sequential
-- scan regardless, and it will be instant. This is here so that adding it is
-- not a migration run during a future performance problem, not because it
-- speeds anything up today.
--
-- Additive: no table is altered and no row moves.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS games_title_trgm_idx
  ON games USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS games_publisher_trgm_idx
  ON games USING gin (publisher gin_trgm_ops);
