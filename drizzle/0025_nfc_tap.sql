ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_reader" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_seq" integer DEFAULT 0 NOT NULL;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_disk_id" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_expires_at" timestamp with time zone;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result_seq" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_result_uid" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_tap_at" timestamp with time zone;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_tap_outcome" text;
