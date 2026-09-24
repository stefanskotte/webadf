ALTER TABLE "disks" ADD COLUMN "max_track_bits" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "track_max_bytes" integer;