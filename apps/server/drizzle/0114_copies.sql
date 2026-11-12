ALTER TABLE "machines" ADD COLUMN "server_order" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "server_pin" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "server_why" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "memory" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "cores" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_state" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_progress" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_error" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_name" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_old" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "data_left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "upload_state" text;--> statement-breakpoint
ALTER TABLE "public_links" ADD COLUMN "next_key_enc" text;--> statement-breakpoint
CREATE UNIQUE INDEX "machines_server_order" ON "machines" USING btree ("server_order");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_server_pin" ON "machines" USING btree ("server_pin") WHERE server_pin <> 'none';--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_server_order_range" CHECK (server_order >= 1);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_server_pin_value" CHECK (server_pin = 'none' OR CASE WHEN server_pin ~ '^[1-9][0-9]{0,2}$' THEN server_pin::int >= 2 ELSE false END);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_copy_progress_range" CHECK (copy_progress BETWEEN 0 AND 99);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_copy_state" CHECK (copy_state IS NULL OR copy_state IN ('making', 'remaking', 'ready', 'stopped'));--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_copy_error" CHECK (copy_error IS NULL OR copy_error IN ('disk_full', 'apply', 'led', 'setup'));--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_upload_state" CHECK (upload_state IS NULL OR upload_state IN ('waiting', 'received', 'kept'));--> statement-breakpoint
-- The row the leader writes each second while copies exist, so each copy knows in the leader's clock how far it reaches.
CREATE TABLE net.pulse (id boolean PRIMARY KEY DEFAULT true CHECK (id), at timestamptz NOT NULL);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.pulse
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
-- A merge also reads what a machine uploaded when it stopped holding the company's data, and knows which machine a
-- database came from.
ALTER TABLE net.merges DROP CONSTRAINT merges_source_check;
--> statement-breakpoint
ALTER TABLE net.merges ADD CONSTRAINT merges_source CHECK (source ~ '^(kept|machine|upload):.+$');
--> statement-breakpoint
ALTER TABLE net.merges ADD COLUMN machine uuid;
