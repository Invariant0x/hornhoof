-- The file store on the company's machines (#2021, after step 1's 0167_file_store): each file kept sealed on as many of
-- the company's machines as the CEO sets, two by default, one copy to a machine, so losing one machine loses no file.
-- Every copy is sealed under the salt its record names, so every copy is the same bytes. Only adds: a database that ran
-- step 1, with its files in the server's store and no copy on record, gets the server's own copies recorded by the app.
--
-- wanted_at: when the leading app last missed a file, so a machine that holds it sends it.
ALTER TABLE net.files ADD COLUMN wanted_at timestamptz;
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
