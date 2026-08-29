CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"firmware_version" text,
	"mac_address" text,
	"last_seen_at" timestamp with time zone,
	"rssi" integer,
	"psram_free" integer,
	"mounted_game_id" text,
	"mounted_disk_no" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mount_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"org_id" text NOT NULL,
	"game_id" text NOT NULL,
	"disk_no" integer NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mount_jobs" ADD CONSTRAINT "mount_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_org_idx" ON "devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mount_jobs_device_state_idx" ON "mount_jobs" USING btree ("device_id","state");--> statement-breakpoint
CREATE INDEX "mount_jobs_org_idx" ON "mount_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pairing_codes_org_idx" ON "pairing_codes" USING btree ("org_id");