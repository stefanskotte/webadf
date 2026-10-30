-- Collection names are unique per library, any case (Files 2 operator ruling R3). A library may already hold names that
-- differ only in case (a self-hosted one may; production held none on 2026-10-29), so they are renamed first: the oldest
-- of each (org_id, lower(name)) group (created_at, then id) keeps its name, each later one becomes "<name> (2)",
-- "<name> (3)", ... with a suffix no collection of that org already uses in any case, the name trimmed so the result
-- stays within the Library's 80 characters.
DO $$
DECLARE
  r record;
  n integer;
  suffix text;
  candidate text;
BEGIN
  FOR r IN
    SELECT d.id, d.org_id, d.name FROM (
      SELECT id, org_id, name,
        row_number() OVER (PARTITION BY org_id, lower(name) ORDER BY created_at, id) AS rn
      FROM collections
    ) d
    WHERE d.rn > 1
    ORDER BY d.org_id, lower(d.name), d.rn
  LOOP
    n := 2;
    LOOP
      suffix := ' (' || n || ')';
      candidate := rtrim(left(r.name, 80 - length(suffix))) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM collections c WHERE c.org_id = r.org_id AND lower(c.name) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE collections SET name = candidate WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "collections_org_name_uq" ON "collections" USING btree ("org_id",lower("name"));
