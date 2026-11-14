-- The bundles the company's data machine made: what each holds, who signed it, whom it is sealed to and which machines
-- keep it. Only the leading app writes it, on its own keeper's word, under the fence. head: the bundle's head line as
-- recorded, so a later check reads the same bytes.
CREATE TABLE net.backups (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  dumped_at timestamptz NOT NULL,
  made_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('timer', 'update')),
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  signer uuid NOT NULL,
  serial text NOT NULL,
  recovery text,
  recipients text[] NOT NULL,
  migrations integer NOT NULL,
  head text NOT NULL,
  holders uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX backups_made_at ON net.backups (made_at);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.backups
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
