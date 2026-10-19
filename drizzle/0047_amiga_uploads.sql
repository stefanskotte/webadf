CREATE TABLE "amiga_upload_chunks" (
	"upload_id" text NOT NULL,
	"offset" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "amiga_upload_chunks_upload_id_offset_pk" PRIMARY KEY("upload_id","offset")
);
--> statement-breakpoint
CREATE TABLE "amiga_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" text,
	"device_name" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"crc32" bigint,
	"protection" bigint DEFAULT 0 NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"amiga_date" text NOT NULL,
	"status" text DEFAULT 'receiving' NOT NULL,
	"received_bytes" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"blob_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"library_disk_id" text
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "up_key" text;--> statement-breakpoint
ALTER TABLE "amiga_upload_chunks" ADD CONSTRAINT "amiga_upload_chunks_upload_id_amiga_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."amiga_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amiga_uploads" ADD CONSTRAINT "amiga_uploads_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amiga_uploads_org_idx" ON "amiga_uploads" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "amiga_uploads_device_idx" ON "amiga_uploads" USING btree ("device_id","status");