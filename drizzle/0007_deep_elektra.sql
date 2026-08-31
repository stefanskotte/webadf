CREATE TABLE "tosec_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"set_name" text NOT NULL,
	"set_version" text,
	"game_name" text NOT NULL,
	"rom_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"crc32" text,
	"md5" text,
	"sha1" text,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"year" integer,
	"publisher" text,
	"disk_no" integer,
	"disk_count" integer,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "crc32" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "md5" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "sha1" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "hashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "tosec_entry_id" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "match_state" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "match_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tosec_sha1_idx" ON "tosec_entries" USING btree ("sha1");--> statement-breakpoint
CREATE INDEX "tosec_md5_idx" ON "tosec_entries" USING btree ("md5");--> statement-breakpoint
CREATE INDEX "tosec_crc_size_idx" ON "tosec_entries" USING btree ("crc32","size_bytes");--> statement-breakpoint
CREATE INDEX "blobs_hashed_at_idx" ON "blobs" USING btree ("hashed_at");--> statement-breakpoint
CREATE INDEX "blobs_match_checked_idx" ON "blobs" USING btree ("match_checked_at");