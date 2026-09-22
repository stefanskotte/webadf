CREATE TABLE "firmware_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"sequence" integer NOT NULL,
	"semver" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"blob_path" text NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"notes" text,
	"security" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_user_id" text NOT NULL,
	CONSTRAINT "firmware_releases_version_key" UNIQUE("version"),
	CONSTRAINT "firmware_releases_sequence_key" UNIQUE("sequence")
);
