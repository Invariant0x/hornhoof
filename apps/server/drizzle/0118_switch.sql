ALTER TABLE "agents" ADD COLUMN "builtin_machine" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "builtin_machine" text;--> statement-breakpoint
ALTER TABLE "test_parts" ADD COLUMN "builtin_machine" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_builtin_machine" CHECK (builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_builtin_machine" CHECK (builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$');--> statement-breakpoint
ALTER TABLE "test_parts" ADD CONSTRAINT "test_parts_builtin_machine" CHECK (builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$');--> statement-breakpoint
-- The CEO's request to move the server to another machine, and how far it is: one at a time.
CREATE TABLE net.move (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  request uuid NOT NULL DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES machines(id),
  from_machine_id uuid NOT NULL REFERENCES machines(id),
  asked_by uuid NOT NULL REFERENCES people(id),
  asked_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing', 'switching', 'failed')),
  reason text CHECK (reason IN ('no_answer', 'not_ready', 'behind', 'no_link', 'expired', 'left')),
  ended_at timestamptz,
  CONSTRAINT move_failed CHECK ((state = 'failed' AND reason IS NOT NULL AND ended_at IS NOT NULL) OR (state <> 'failed' AND reason IS NULL AND ended_at IS NULL))
);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.move
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
-- Each planned switch, as the machine that took the server wrote it down: who led before, under which term, up to
-- which position of its log, and the slot it made for each machine that keeps a copy.
CREATE TABLE net.handovers (
  id uuid PRIMARY KEY,
  from_machine_id uuid NOT NULL REFERENCES machines(id),
  term_number bigint NOT NULL,
  term_machine text NOT NULL,
  applied text NOT NULL,
  to_machine_id uuid NOT NULL REFERENCES machines(id),
  at timestamptz NOT NULL,
  slots jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.handovers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
-- The handover this database's time as the leader ended with: to which machine, at which position, and when.
ALTER TABLE net_local.state ADD COLUMN handed_to text, ADD COLUMN handed_lsn text, ADD COLUMN handed_at timestamptz;
--> statement-breakpoint
ALTER TABLE net_local.state ADD CONSTRAINT state_handed CHECK ((handed_to IS NULL) = (handed_lsn IS NULL) AND (handed_to IS NULL) = (handed_at IS NULL));
