-- What a merge did when a database of the company came back after it went its own way. Only the leading app writes
-- these, under the fence. merges: one row per source, a database a restore kept (kept:<name>) or a machine
-- (machine:<id>), with how far it got. xact: the merge's own transaction, as the journal names it.
CREATE TABLE net.merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL UNIQUE CHECK (source ~ '^(kept|machine):.+$'),
  label text NOT NULL,
  path text CHECK (path IN ('journal', 'compare')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'merged', 'removing', 'done')),
  fork uuid,
  cutoff timestamptz,
  xact uuid,
  task_id uuid,
  task_wanted boolean NOT NULL DEFAULT false,
  tasks uuid[] NOT NULL DEFAULT '{}',
  code jsonb NOT NULL DEFAULT '[]',
  from_at timestamptz,
  to_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}',
  tries integer NOT NULL DEFAULT 0,
  tried_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  merged_at timestamptz,
  done_at timestamptz
);
--> statement-breakpoint
-- What a row's key alone does not show: a row of a transaction the leader had done already (skipped), a row that is
-- another row here (matched, with this side's key in here), and a row written with other values than the source's
-- (rewritten, with those columns and the source's values in was).
CREATE TABLE net.merge_rows (
  merge uuid NOT NULL REFERENCES net.merges (id),
  tbl text NOT NULL,
  key jsonb NOT NULL,
  how text NOT NULL CHECK (how IN ('skipped', 'matched', 'rewritten')),
  cols text[] NOT NULL DEFAULT '{}',
  was jsonb,
  here jsonb,
  PRIMARY KEY (merge, tbl, key)
);
--> statement-breakpoint
CREATE INDEX merge_rows_key ON net.merge_rows (tbl, key);
--> statement-breakpoint
-- A difference the merge could not prove, with both values: here is this side's row and there the source's, each a
-- row's to_jsonb or null for no row. op: what taking the source's side would run. carried: the id the conflict had in
-- the database it came from. picked_by: person:<id> or agent:<id>.
CREATE TABLE net.merge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merge uuid NOT NULL REFERENCES net.merges (id),
  carried uuid,
  tbl text NOT NULL,
  key jsonb NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  kind text NOT NULL CHECK (kind IN ('differs', 'changed_removed', 'removed_changed', 'still_used', 'refused')),
  topic text NOT NULL CHECK (topic IN ('people', 'access', 'plans', 'machines', 'protected', 'work')),
  task_id uuid,
  cols text[] NOT NULL DEFAULT '{}',
  here jsonb,
  there jsonb,
  at timestamptz,
  why text NOT NULL,
  picked text CHECK (picked IN ('here', 'there', 'value')),
  value jsonb,
  picked_by text,
  picked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (merge, tbl, key, carried)
);
--> statement-breakpoint
CREATE INDEX merge_conflicts_open ON net.merge_conflicts (merge) WHERE picked IS NULL;
--> statement-breakpoint
CREATE INDEX merge_conflicts_key ON net.merge_conflicts (tbl, key);
--> statement-breakpoint
-- The journal rows of a source that a merge has dealt with, so no later merge reads them as new.
CREATE TABLE net.merge_consumed (
  journal uuid PRIMARY KEY,
  merge uuid NOT NULL REFERENCES net.merges (id),
  at timestamptz NOT NULL,
  how text NOT NULL CHECK (how IN ('applied', 'skipped', 'conflict', 'equal'))
);
--> statement-breakpoint
CREATE INDEX merge_consumed_at ON net.merge_consumed (at);
--> statement-breakpoint
-- The mark a restore leaves: which bundle this database was restored from, and the database it kept.
CREATE TABLE net.restores (
  attempt uuid PRIMARY KEY,
  backup uuid NOT NULL,
  dumped_at timestamptz NOT NULL,
  kept text,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Below this time the journal was pruned here, so it proves nothing of what happened before.
CREATE TABLE net.horizon (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  below timestamptz NOT NULL
);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.merges
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.merge_rows
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.merge_conflicts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.merge_consumed
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.restores
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.horizon
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
-- A database set aside before a merge is saved as a bundle too, with a reason of its own.
ALTER TABLE net.backups DROP CONSTRAINT backups_reason_check;
--> statement-breakpoint
ALTER TABLE net.backups ADD CONSTRAINT backups_reason CHECK (reason IN ('timer', 'update', 'fork'));
