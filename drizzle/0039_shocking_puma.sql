CREATE TABLE "tosec_fetch" (
	"id" text PRIMARY KEY NOT NULL,
	"release" text,
	"imported_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_result" text
);
