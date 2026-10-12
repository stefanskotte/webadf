-- drizzle/0034_paulanet_net.sql  (spec 2026-10-12 paulanet-phase3 §5; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_driver_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_amiga_ip" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_frames_in" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "net_frames_out" integer;
