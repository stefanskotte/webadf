ALTER TABLE "devices" ADD COLUMN "orig_drive" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_applied_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_reported" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_capable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_present" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "orig_drive_active" boolean DEFAULT false NOT NULL;