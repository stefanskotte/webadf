ALTER TABLE "disks" ADD COLUMN "image_format" text DEFAULT 'adf' NOT NULL;--> statement-breakpoint
ALTER TABLE "disks" ADD COLUMN "extractable" boolean;--> statement-breakpoint
ALTER TABLE "disks" ADD COLUMN "extract_reason" text;