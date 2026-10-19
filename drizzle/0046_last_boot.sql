ALTER TABLE "devices" ADD COLUMN "last_boot" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_boot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "nfc_last_fail" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "nfc_last_fail_at" timestamp with time zone;