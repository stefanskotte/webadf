-- drizzle/0030_display_layouts.sql  (spec 2026-10-04-oled-layouts §7; additive)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_panel" text DEFAULT '128x32' NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_layout" bytea;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_applied_version" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_error" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_layouts" boolean;
