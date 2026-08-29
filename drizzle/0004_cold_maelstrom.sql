DROP TABLE "mount_jobs" CASCADE;--> statement-breakpoint
ALTER TABLE "disks" ADD COLUMN "write_protected" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "mounted_sha256" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_sha256" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_game_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_disk_no" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error_at" timestamp with time zone;