ALTER TABLE "devices" ADD COLUMN "write_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "amiga_dest" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "on_clash" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "move_source" text;--> statement-breakpoint
CREATE INDEX "transfers_job_idx" ON "transfers" USING btree ("job_id");