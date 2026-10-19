ALTER TABLE "devices" ADD COLUMN "boot_disk" text DEFAULT 'last' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "boot_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "prev_boot_id" text;