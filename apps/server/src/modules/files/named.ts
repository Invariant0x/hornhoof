import { sql } from 'drizzle-orm';

/* The rows that name a content of the store: files, an archive of agents' old history, and a file's row a merge refused
   and keeps until someone picks it. */
export const NAMED = sql`(EXISTS (SELECT 1 FROM public.attachments a WHERE a.sha256 = f.sha256)
  OR EXISTS (SELECT 1 FROM public.agent_event_archives x WHERE x.sha256 = f.sha256)
  OR EXISTS (SELECT 1 FROM net.merge_conflicts c WHERE c.tbl = 'attachments' AND c.picked IS NULL AND f.sha256 IN (c.here ->> 'sha256', c.there ->> 'sha256')))`;

/* A database a restore set aside, or one made of what a machine uploaded, may be merged back: the files its rows name
   stay while it is there, for at most the 30 days it is kept. */
export const SET_ASIDE = sql`EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname LIKE 'hornhoof_before_%' OR datname LIKE 'hornhoof_upload_%')`;
