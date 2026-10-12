-- drizzle/0035_paulanet_net_next.sql  (plan 2026-10-12 pre-flight I2: the poll's one-shot cursor for the driver disk; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_next_sent_version" integer;
