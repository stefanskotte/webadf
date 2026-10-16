CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"crc32" bigint NOT NULL,
	"protection" bigint DEFAULT 0 NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"blob_sha256" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"error_text" text,
	"saved_as" text,
	"bytes_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "send_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "send_rx" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "send_rx_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfers_device_idx" ON "transfers" USING btree ("device_id","status","created_at");