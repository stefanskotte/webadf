CREATE TABLE "demozoo_dismissals" (
	"org_id" text NOT NULL,
	"game_id" text NOT NULL,
	"production_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demozoo_dismissals_game_id_production_id_pk" PRIMARY KEY("game_id","production_id")
);
--> statement-breakpoint
CREATE TABLE "demozoo_images" (
	"sha1" text PRIMARY KEY NOT NULL,
	"screenshot_id" integer NOT NULL,
	"production_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "demozoo_import" (
	"id" integer PRIMARY KEY NOT NULL,
	"step" text DEFAULT 'applied' NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_attempt_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"run_started_at" timestamp with time zone,
	"productions_written" integer DEFAULT 0 NOT NULL,
	"screenshots_written" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "demozoo_productions" (
	"id" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"release_year" integer,
	"supertype" text NOT NULL,
	"types" text[] DEFAULT '{}'::text[] NOT NULL,
	"groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_game" boolean DEFAULT false NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demozoo_screenshots" (
	"id" integer PRIMARY KEY NOT NULL,
	"production_id" integer NOT NULL,
	"standard_url" text NOT NULL,
	"ordinal" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demozoo_suggestions" (
	"sha256" text NOT NULL,
	"production_id" integer NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "demozoo_suggestions_sha256_production_id_pk" PRIMARY KEY("sha256","production_id")
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "demozoo_production_id" integer;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "demozoo_state" text;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "demozoo_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "demozoo_production_id" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "demozoo_link_source" text;--> statement-breakpoint
ALTER TABLE "demozoo_dismissals" ADD CONSTRAINT "demozoo_dismissals_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demozoo_dismissals" ADD CONSTRAINT "demozoo_dismissals_production_id_demozoo_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."demozoo_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demozoo_screenshots" ADD CONSTRAINT "demozoo_screenshots_production_id_demozoo_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."demozoo_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demozoo_suggestions" ADD CONSTRAINT "demozoo_suggestions_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demozoo_suggestions" ADD CONSTRAINT "demozoo_suggestions_production_id_demozoo_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."demozoo_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dz_img_prod_idx" ON "demozoo_images" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "dz_img_fetched_idx" ON "demozoo_images" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "dz_prod_title_key_idx" ON "demozoo_productions" USING btree ("title_key");--> statement-breakpoint
CREATE INDEX "dz_shot_prod_idx" ON "demozoo_screenshots" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "dz_sugg_prod_idx" ON "demozoo_suggestions" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "blobs_demozoo_checked_idx" ON "blobs" USING btree ("demozoo_checked_at");