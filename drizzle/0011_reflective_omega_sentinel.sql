CREATE TABLE "collection_games" (
	"collection_id" text NOT NULL,
	"game_id" text NOT NULL,
	"sort_key" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_games_collection_id_game_id_pk" PRIMARY KEY("collection_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_key" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_games" ADD CONSTRAINT "collection_games_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_games" ADD CONSTRAINT "collection_games_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_games_sort_idx" ON "collection_games" USING btree ("collection_id","sort_key");--> statement-breakpoint
CREATE INDEX "collection_games_game_idx" ON "collection_games" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "collections_org_sort_idx" ON "collections" USING btree ("org_id","sort_key");