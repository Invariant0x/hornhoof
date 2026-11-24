import { sql } from 'drizzle-orm';

/* The rows that name a content of the store: files, and a file's row a merge refused and keeps until someone picks it. */
export const NAMED = sql`(EXISTS (SELECT 1 FROM public.attachments a WHERE a.sha256 = f.sha256)
  OR EXISTS (SELECT 1 FROM net.merge_conflicts c WHERE c.tbl = 'attachments' AND c.picked IS NULL AND f.sha256 IN (c.here ->> 'sha256', c.there ->> 'sha256')))`;
