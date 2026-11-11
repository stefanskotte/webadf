ALTER TABLE "devices" ADD COLUMN "drive_base" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "devices" SET "drive_base" = 1 WHERE "fitted_as" = 'external';
