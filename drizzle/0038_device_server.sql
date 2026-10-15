-- drizzle/0038_device_server.sql  (spec 2026-10-15 board server override; additive, nullable)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "server_custom" boolean;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "server_tls" text;
