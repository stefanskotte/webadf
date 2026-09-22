ALTER TABLE "devices" ADD COLUMN "update_protocol" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_firmware_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_firmware_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "desired_firmware_set_by_user_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_update_state" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_update_error" text;