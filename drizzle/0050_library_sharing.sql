CREATE TABLE "library_share_collections" (
	"share_id" text NOT NULL,
	"collection_id" text NOT NULL,
	CONSTRAINT "library_share_collections_share_id_collection_id_pk" PRIMARY KEY("share_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "library_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text NOT NULL,
	"everything" boolean DEFAULT false NOT NULL,
	"claim_code_hash" text,
	"claim_expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"claimed_at" timestamp with time zone,
	"claimed_by_url" text,
	"claimed_by_name" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_libraries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"base_url" text NOT NULL,
	"token_enc" text NOT NULL,
	"tls_pin" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "disks" ADD COLUMN "remote_library_id" text;--> statement-breakpoint
ALTER TABLE "disks" ADD COLUMN "remote_disk_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "remote_library_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "remote_title_id" text;--> statement-breakpoint
ALTER TABLE "library_share_collections" ADD CONSTRAINT "library_share_collections_share_id_library_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."library_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_share_collections" ADD CONSTRAINT "library_share_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_share_collections_coll_idx" ON "library_share_collections" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "library_shares_org_idx" ON "library_shares" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_shares_code_idx" ON "library_shares" USING btree ("claim_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "library_shares_token_idx" ON "library_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "remote_libraries_org_idx" ON "remote_libraries" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "disks" ADD CONSTRAINT "disks_remote_library_id_remote_libraries_id_fk" FOREIGN KEY ("remote_library_id") REFERENCES "public"."remote_libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_remote_library_id_remote_libraries_id_fk" FOREIGN KEY ("remote_library_id") REFERENCES "public"."remote_libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disks_remote_idx" ON "disks" USING btree ("remote_library_id","remote_disk_id");--> statement-breakpoint
CREATE INDEX "games_remote_idx" ON "games" USING btree ("remote_library_id");