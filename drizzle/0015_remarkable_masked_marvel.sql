CREATE TABLE "disk_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"disk_id" text NOT NULL,
	"org_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"blob_sha256" text NOT NULL,
	"image_sha256" text NOT NULL,
	"source" text NOT NULL,
	"device_id" text,
	"user_id" text,
	"rewind_of" integer,
	"sector_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disk_versions_disk_seq" UNIQUE("disk_id","seq")
);
--> statement-breakpoint
CREATE TABLE "disk_write_sessions" (
	"device_id" text NOT NULL,
	"mount" integer NOT NULL,
	"disk_id" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disk_write_sessions_device_id_mount_pk" PRIMARY KEY("device_id","mount")
);
--> statement-breakpoint
CREATE TABLE "disk_write_tracks" (
	"device_id" text NOT NULL,
	"mount" integer NOT NULL,
	"track" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "disk_write_tracks_device_id_mount_track_pk" PRIMARY KEY("device_id","mount","track")
);
--> statement-breakpoint
ALTER TABLE "disk_versions" ADD CONSTRAINT "disk_versions_disk_id_disks_id_fk" FOREIGN KEY ("disk_id") REFERENCES "public"."disks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disk_write_sessions" ADD CONSTRAINT "disk_write_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disk_write_sessions" ADD CONSTRAINT "disk_write_sessions_disk_id_disks_id_fk" FOREIGN KEY ("disk_id") REFERENCES "public"."disks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disk_write_tracks" ADD CONSTRAINT "disk_write_tracks_device_id_mount_disk_write_sessions_device_id_mount_fk" FOREIGN KEY ("device_id","mount") REFERENCES "public"."disk_write_sessions"("device_id","mount") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disk_versions_image_idx" ON "disk_versions" USING btree ("image_sha256");