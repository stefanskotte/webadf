ALTER TABLE "devices" ADD COLUMN "firmware_instruction_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_instruction_ack" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "firmware_releases" ADD COLUMN "channel" text DEFAULT 'release' NOT NULL;