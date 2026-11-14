-- The restored database takes the place of the one that closed: it goes by the same machine and cluster, its term is
-- no lower than any the closed one gave, and it holds no lease, so its keeper takes a new one. The updater sets
-- hornhoof.term, hornhoof.machine and hornhoof.cluster in the session first, as cutover.sql answered them. A database
-- from before the network has no such state and stays as it is.
DO $do$
DECLARE
  old_term bigint := current_setting('hornhoof.term')::bigint;
  old_machine text := NULLIF(current_setting('hornhoof.machine'), '');
  old_cluster text := NULLIF(current_setting('hornhoof.cluster'), '');
BEGIN
  IF to_regclass('net_local.state') IS NULL THEN
    RETURN;
  END IF;
  IF old_machine IS NOT NULL AND old_cluster IS NOT NULL THEN
    INSERT INTO net_local.state AS s (term_number, term_machine, term_split, machine, cluster) VALUES (old_term, old_machine, false, old_machine, old_cluster)
    ON CONFLICT (id) DO UPDATE SET term_number = GREATEST(s.term_number, EXCLUDED.term_number), machine = EXCLUDED.machine, cluster = EXCLUDED.cluster;
  ELSE
    UPDATE net_local.state SET term_number = GREATEST(term_number, old_term);
  END IF;
  DELETE FROM net_local.lease;
END
$do$;
