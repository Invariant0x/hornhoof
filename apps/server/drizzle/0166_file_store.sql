-- Files leave the database (#2021): a row keeps the sha256 of its bytes, and the bytes live in the company's file store
-- on its machines. A row still carrying bytes, from before, is moved by the leading app and then cleared; once none
-- carries any, the column goes. On a database where no row carries bytes, a new one, it goes here and now.
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
-- Each file of the store once, by the sha256 of its plain bytes, with the hash and size of the sealed bytes the machines
-- keep. unused_since: when the sweep last found no row naming it; drop_at: from when the machines take it away;
-- wanted_at: when the leading app last missed it, so a machine that holds it sends it.
CREATE TABLE net.files (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  sealed_sha256 text NOT NULL CHECK (sealed_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_size bigint NOT NULL CHECK (sealed_size > 0),
  made_at timestamptz NOT NULL DEFAULT now(),
  unused_since timestamptz,
  drop_at timestamptz,
  wanted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX files_made_at ON net.files (made_at, sha256);
--> statement-breakpoint
-- Which machine said it keeps which file.
CREATE TABLE net.file_copies (
  sha256 text NOT NULL REFERENCES net.files (sha256) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, machine_id)
);
--> statement-breakpoint
CREATE INDEX file_copies_machine ON net.file_copies (machine_id);
--> statement-breakpoint
-- The machines that keep no data and were picked to keep the files too, as backups are.
CREATE TABLE net.file_holders (
  machine_id uuid PRIMARY KEY,
  since timestamptz NOT NULL DEFAULT now()
);
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
CREATE CONSTRAINT TRIGGER net_fence AFTER INSERT OR UPDATE OR DELETE ON net.file_holders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION net.fence_check();
