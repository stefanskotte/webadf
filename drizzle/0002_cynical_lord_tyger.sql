CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "invites_org_idx" ON "invites" USING btree ("org_id");