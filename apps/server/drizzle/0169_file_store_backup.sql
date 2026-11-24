-- The store's own backup (#2056): each content a row names, kept apart from the live copies on the machine picked for
-- it, until 30 days, or the days the CEO set, after no row names it. Its copies are never live copies: none of them is in
-- net.file_copies. One row of settings: the days, and the machine the backup is on now (none: the leading one).
CREATE TABLE net.file_backup_settings (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  keep_days integer NOT NULL DEFAULT 30 CHECK (keep_days BETWEEN 1 AND 3650),
  machine_id uuid,
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by text
);
--> statement-breakpoint
-- Each content of the backup once, with the sealed facts of its record when it came: machine_id is the machine that
-- keeps it, and kept_at when it was last found kept there; none yet while it is on its way.
CREATE TABLE net.file_backups (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  sealed_sha256 text NOT NULL CHECK (sealed_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_size bigint NOT NULL CHECK (sealed_size > 0),
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
  at timestamptz NOT NULL DEFAULT now(),
  machine_id uuid,
  kept_at timestamptz
);
--> statement-breakpoint
-- Which row of attachments named which content, from when until when: a row deleted or given other bytes closes its
-- name, and a content goes from the backup once its last name closed longer ago than the days kept. The row as it was,
-- without any bytes, puts it back in a restore.
CREATE TABLE net.file_backup_names (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  "row" jsonb NOT NULL,
  since timestamptz NOT NULL,
  until timestamptz,
  CHECK (until IS NULL OR until >= since)
);
--> statement-breakpoint
CREATE UNIQUE INDEX file_backup_names_open ON net.file_backup_names (attachment_id) WHERE until IS NULL;
--> statement-breakpoint
CREATE INDEX file_backup_names_sha256 ON net.file_backup_names (sha256);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_backup_settings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_backups
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_backup_names
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
