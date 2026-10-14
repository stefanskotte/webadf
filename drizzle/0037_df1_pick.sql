-- drizzle/0037_df1_pick.sql  (spec 2026-10-14 df1-any-disk §4.1; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_disk_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "df1_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "devices" ADD CONSTRAINT "devices_df1_disk_id_disks_id_fk" FOREIGN KEY ("df1_disk_id") REFERENCES "public"."disks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
