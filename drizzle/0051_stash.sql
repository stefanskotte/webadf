ALTER TABLE "amiga_uploads" ALTER COLUMN "device_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD COLUMN "source" text DEFAULT 'amiga' NOT NULL;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD COLUMN "kind" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD COLUMN "sent_name" text;