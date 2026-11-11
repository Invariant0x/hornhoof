CREATE FUNCTION net.assert_lease(margin interval, invocation uuid, job uuid, answer jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, net_local, pg_temp AS $fn$
BEGIN
  PERFORM net.assert_lease(margin, invocation);
  IF invocation IS NOT NULL THEN
    INSERT INTO public.tool_calls (id, job_id, answer) VALUES (invocation, job, answer);
    INSERT INTO public.applied (source, base) VALUES ('tool:' || invocation::text || ':0', 'tool:' || invocation::text);
  END IF;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION net.assert_lease(interval, uuid, uuid, jsonb) FROM PUBLIC;
