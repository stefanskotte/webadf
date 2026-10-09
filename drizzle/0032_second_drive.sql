-- drizzle/0032_second_drive.sql  (spec 2026-10-08 df1-second-drive §3; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_applied_version" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_reported" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "second_drive_capable" boolean;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_sha256" text;