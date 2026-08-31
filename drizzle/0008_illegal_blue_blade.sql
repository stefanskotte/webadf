CREATE TABLE "openretro_disk_sha1" (
	"sha1" text NOT NULL,
	"entry_uuid" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openretro_entries" (
	"uuid" text PRIMARY KEY NOT NULL,
	"game_name" text NOT NULL,
	"slug" text,
	"publisher" text,
	"developer" text,
	"year" integer,
	"languages" text,
	"players" text,
	"tags" text,
	"chipset" text,
	"front_sha1" text,
	"title_sha1" text,
	"screenshot_sha1s" text,
	"hol_url" text,
	"mobygames_url" text,
	"lemon_url" text,
	"wikipedia_url" text,
	"longplay_url" text,
	"description" text,
	"long_description" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openretro_images" (
	"sha1" text PRIMARY KEY NOT NULL,
	"entry_uuid" text NOT NULL,
	"kind" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "openretro_entry_id" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "enrich_state" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "enrich_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "developer" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "players" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "history" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "facts_source" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "prose_source" text;--> statement-breakpoint
CREATE INDEX "oagd_sha1_idx" ON "openretro_disk_sha1" USING btree ("sha1");--> statement-breakpoint
CREATE INDEX "oagd_entry_idx" ON "openretro_disk_sha1" USING btree ("entry_uuid");--> statement-breakpoint
CREATE INDEX "oagd_img_entry_idx" ON "openretro_images" USING btree ("entry_uuid");--> statement-breakpoint
CREATE INDEX "blobs_enrich_checked_idx" ON "blobs" USING btree ("enrich_checked_at");