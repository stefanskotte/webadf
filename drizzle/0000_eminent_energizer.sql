CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"size_bytes" integer NOT NULL,
	"gzip_size_bytes" integer,
	"storage_key" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disks" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"org_id" text NOT NULL,
	"disk_no" integer NOT NULL,
	"sha256" text NOT NULL,
	"label" text,
	"tosec_name" text,
	"is_boot" boolean DEFAULT false NOT NULL,
	"size_bytes" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"org_id" text NOT NULL,
	"sha256" text NOT NULL,
	"source_filename" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_org_id_sha256_pk" PRIMARY KEY("org_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"year" integer,
	"publisher" text,
	"genre" text,
	"chipset" text,
	"cover_asset_id" text,
	"metadata_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "disks" ADD CONSTRAINT "disks_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disks" ADD CONSTRAINT "disks_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disks_game_idx" ON "disks" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "disks_org_idx" ON "disks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "entitlements_org_idx" ON "entitlements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "games_org_sort_idx" ON "games" USING btree ("org_id","sort_title");--> statement-breakpoint
CREATE INDEX "games_org_created_idx" ON "games" USING btree ("org_id","created_at");