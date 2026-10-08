-- drizzle/0031_sel1_telemetry.sql  (spec 2026-10-08 df1-second-drive §6 step 0; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "sel1_wired" boolean;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_seen" boolean;
