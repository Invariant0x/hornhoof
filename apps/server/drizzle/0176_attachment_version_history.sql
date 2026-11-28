-- Seed existing attachment history once while attachment writers are excluded.
LOCK TABLE public.attachments IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE net.file_backup_names n SET until = greatest(n.since, statement_timestamp())
WHERE n.until IS NULL AND NOT EXISTS (
  SELECT 1 FROM public.attachments a WHERE a.id = n.attachment_id AND a.sha256 = n.sha256
);
--> statement-breakpoint
INSERT INTO net.file_backup_names (attachment_id, company_id, sha256, "row", since)
SELECT a.id, a.company_id, a.sha256, to_jsonb(a) - 'bytes', statement_timestamp()
FROM public.attachments a
WHERE a.sha256 IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM net.file_backup_names n WHERE n.attachment_id = a.id AND n.until IS NULL
);
--> statement-breakpoint
CREATE FUNCTION net.attachment_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'UPDATE' AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
       AND (to_jsonb(OLD) - 'bytes') = (to_jsonb(NEW) - 'bytes') THEN
      RETURN NULL;
    END IF;
    UPDATE net.file_backup_names SET until = greatest(since, changed_at)
      WHERE attachment_id = OLD.id AND until IS NULL
      RETURNING until INTO changed_at;
    changed_at := coalesce(changed_at, clock_timestamp());
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.sha256 IS NOT NULL THEN
    INSERT INTO net.file_backup_names (attachment_id, company_id, sha256, "row", since)
      VALUES (NEW.id, NEW.company_id, NEW.sha256, to_jsonb(NEW) - 'bytes', changed_at);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachment_backup_version AFTER INSERT OR UPDATE OR DELETE ON public.attachments
FOR EACH ROW EXECUTE FUNCTION net.attachment_version();
