import { sql } from 'drizzle-orm';

/* Every row that names a content of the store, with the size it gives it: a file, and a file of an installed theme. */
export const NAMED_CONTENTS = sql`(SELECT a.sha256, a.size FROM public.attachments a WHERE a.sha256 IS NOT NULL
  UNION ALL SELECT t.sha256, t.size FROM public.theme_files t)`;
