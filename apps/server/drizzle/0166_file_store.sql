-- Files leave the database (#2021): a row keeps the sha256 of its bytes, and the bytes live in the company's file store
-- on its machines. A row still carrying bytes, from before, is moved by the leading app, and cleared once the CEO says yes
-- to the reconciliation that lists it; once none carries any, the column goes. On a database where no row carries bytes,
-- a new one, it goes here and now.
ALTER TABLE "attachments" ADD COLUMN "sha256" text;
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sha256" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "bytes" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "attachments" WHERE octet_length("bytes") > 0) THEN
    ALTER TABLE "attachments" DROP COLUMN "bytes";
  END IF;
END $$;
--> statement-breakpoint
-- The key every file of the store is sealed with, encrypted with the company secret as the authority's key is. One row.
CREATE TABLE net.file_key (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  key_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Each file of the store once, by the sha256 of its plain bytes, with the hash, size and salt of the sealed bytes the
-- machines keep: every copy is sealed under that salt, so every copy is the same bytes. unused_since: when the sweep last found no row naming it; drop_at: from when the machines take it away;
-- wanted_at: when the leading app last missed it, so a machine that holds it sends it.
CREATE TABLE net.files (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  sealed_sha256 text NOT NULL CHECK (sealed_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_size bigint NOT NULL CHECK (sealed_size > 0),
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
  made_at timestamptz NOT NULL DEFAULT now(),
  unused_since timestamptz,
  drop_at timestamptz,
  wanted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX files_made_at ON net.files (made_at, sha256);
--> statement-breakpoint
-- Which machine said it keeps which file. A copy counts as one of the copies wanted only once it is verified: at once for
-- the leading machine and a data machine, and for another machine once it showed it keeps the bytes it was given.
CREATE TABLE net.file_copies (
  sha256 text NOT NULL REFERENCES net.files (sha256) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sha256, machine_id)
);
--> statement-breakpoint
CREATE INDEX file_copies_machine ON net.file_copies (machine_id);
--> statement-breakpoint
-- How many of the company's machines keep each file, as the CEO set it: each copy on another machine, as far as there are
-- machines that keep files. One row; none means the default, two.
CREATE TABLE net.file_settings (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  copies integer NOT NULL CHECK (copies BETWEEN 1 AND 5),
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by text NOT NULL
);
--> statement-breakpoint
-- The machines picked to keep each file. A machine fetches the files it is picked for, and lets one go only once it is not
-- picked for it any more and the copies asked for stand on machines that are.
CREATE TABLE net.file_targets (
  sha256 text NOT NULL REFERENCES net.files (sha256) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, machine_id)
);
--> statement-breakpoint
CREATE INDEX file_targets_machine ON net.file_targets (machine_id, at, sha256);
--> statement-breakpoint
-- Which machine the leading keeper gave which file to, whole: a machine's word that it keeps a file counts only for one it
-- was given, so a machine that only says so takes no copy's place. With it, what the machine is to show it keeps the
-- bytes: a nonce, a few slices of the sealed file, and their HMAC under the nonce.
CREATE TABLE net.file_gives (
  sha256 text NOT NULL REFERENCES net.files (sha256) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  nonce text NOT NULL CHECK (nonce ~ '^[0-9a-f]{64}$'),
  slices jsonb NOT NULL,
  mac text NOT NULL CHECK (mac ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (sha256, machine_id)
);
--> statement-breakpoint
-- Which machine the leading app asked to send back a file no record describes, and until when: the leading keeper takes
-- such a file only from a machine asked for it, so a machine cannot fill its disk with files nobody asked for.
CREATE TABLE net.file_wants (
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  machine_id uuid NOT NULL,
  until timestamptz NOT NULL,
  PRIMARY KEY (sha256, machine_id)
);
--> statement-breakpoint
-- The reconciliations of the move out of the database. Once every row whose bytes are on the machine is copied into the
-- store, checked and named, the rows named since the last one make a new one: its files, contents and bytes, the rows
-- whose bytes are not on this machine, the size of the database, and the digest of its list. No byte, column or disk file
-- goes before the CEO says yes to a digest, and then only those of its rows.
CREATE TABLE net.file_moves (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  files integer NOT NULL CHECK (files > 0),
  contents integer NOT NULL CHECK (contents > 0),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  not_here integer NOT NULL CHECK (not_here >= 0),
  database_bytes bigint NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text,
  cleared_at timestamptz,
  database_bytes_after bigint,
  CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);
--> statement-breakpoint
-- The rows the mover named, with the sha256 and size of the bytes stored and whether they lay on the disk; digest is the
-- reconciliation that lists them, none yet for a row named since the last one. A row leaves once its bytes are cleared.
CREATE TABLE net.file_move_rows (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  disk boolean NOT NULL,
  digest text REFERENCES net.file_moves (digest)
);
--> statement-breakpoint
CREATE INDEX file_move_rows_digest ON net.file_move_rows (digest, id);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_moves
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_move_rows
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_key
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.files
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_copies
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_settings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_targets
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_gives
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_wants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
