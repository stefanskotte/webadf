CREATE TABLE "remote_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"amiga_path" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"error_code" text,
	"error_text" text,
	"answer" jsonb,
	"pieces" integer DEFAULT 0 NOT NULL,
	"cut" boolean DEFAULT false NOT NULL,
	"target" jsonb,
	"fetch_id" text,
	"upload_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"active_at" timestamp with time zone,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "req_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "rx_proto" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "browse_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_requests" ADD CONSTRAINT "remote_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_requests_device_idx" ON "remote_requests" USING btree ("device_id","status","created_at");--> statement-breakpoint
CREATE INDEX "remote_requests_path_idx" ON "remote_requests" USING btree ("device_id","kind","amiga_path","created_at");--> statement-breakpoint
CREATE INDEX "remote_requests_fetch_idx" ON "remote_requests" USING btree ("fetch_id");