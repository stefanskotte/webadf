ALTER TABLE "devices" ADD COLUMN "wifi_nets" text[];--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_current" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_firmware" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_setup_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_op" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_op_ssid" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_cancelled" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_op_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_ack" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "wifi_result" text;