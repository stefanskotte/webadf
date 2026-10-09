-- drizzle/0033_cover_override.sql  (HANDOFF backlog "Override a title's main image"; additive)
ALTER TABLE "games" ADD COLUMN IF NOT EXISTS "cover_override_sha256" text;
