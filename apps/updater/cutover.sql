-- The database a restore replaces closes here. The updater runs this in one session on that database, opened before
-- it turns the database's connections off from a session on another one, since Postgres lets no session close the
-- database it is on. This waits until they are off, ends every other session and waits until none is left, and only
-- then reads what the restored database must keep: nothing can change it after that. Each statement is committed
-- alone, and a look inside one sees what was committed since the look before.
DO $do$
DECLARE
  looks int := 0;
BEGIN
  WHILE (SELECT datallowconn FROM pg_database WHERE datname = current_database()) LOOP
    looks := looks + 1;
    IF looks > 100 THEN
      RAISE EXCEPTION 'connections still on';
    END IF;
    PERFORM pg_sleep(0.2);
  END LOOP;
END
$do$;
-- A transaction sees its first list of sessions again unless the list is cleared before each look.
DO $do$
DECLARE
  looks int := 0;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();
    PERFORM pg_sleep(0.2);
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid());
    looks := looks + 1;
    IF looks >= 50 THEN
      RAISE EXCEPTION 'sessions left';
    END IF;
  END LOOP;
END
$do$;
-- The highest term this database gave, and the machine and cluster it went by.
SELECT jsonb_build_object(
  'term', GREATEST(COALESCE((SELECT max(term_number) FROM net_local.state), 0), COALESCE((SELECT max(term_number) FROM net_local.lease), 0)),
  'machine', (SELECT machine FROM net_local.state),
  'cluster', (SELECT cluster FROM net_local.state));
