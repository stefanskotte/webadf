-- drizzle/0036_paulanet_net_rearm.sql  (Task 8 review I1: rate limit for re-arming the driver-disk wake; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_next_rearmed_at" timestamp with time zone;
