ALTER TABLE "disk_write_sessions" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "disk_write_sessions" ADD COLUMN "base_sha256" text NOT NULL;