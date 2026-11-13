ALTER TABLE "machines" DROP CONSTRAINT "machines_copy_state";--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "copy_old_led" bigint;--> statement-breakpoint
ALTER TABLE "public_links" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_copy_state" CHECK (copy_state IS NULL OR copy_state IN ('making', 'remaking', 'ready', 'stopped', 'saving'));--> statement-breakpoint
-- A handover is a planned switch, a takeover by the copy that held every confirmed change, or the CEO's choice of a
-- copy to go on from. For the last two: when the new leader last heard the old one, how far its own changes reached,
-- why the old leader stopped when it said so, and when the orchestrator was told.
ALTER TABLE net.handovers
  ADD COLUMN kind text NOT NULL DEFAULT 'planned' CONSTRAINT handovers_kind CHECK (kind IN ('planned', 'takeover', 'ceo')),
  ADD COLUMN heard_at timestamptz,
  ADD COLUMN reach timestamptz,
  ADD COLUMN noted_at timestamptz,
  ADD COLUMN reason text CONSTRAINT handovers_reason CHECK (reason IN ('disk_full'));
--> statement-breakpoint
-- What nodes said of jobs the leader has no row of yet, kept until the database that started them is merged: that a
-- node lists the job, that it started, each event of it, and its end.
CREATE TABLE net.parked (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  node jsonb NOT NULL,
  kind text NOT NULL CONSTRAINT parked_kind CHECK (kind IN ('listed', 'started', 'event', 'done')),
  body jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz
);
--> statement-breakpoint
CREATE INDEX parked_job ON net.parked (job_id);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.parked
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
