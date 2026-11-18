import { and, eq, inArray, or } from 'drizzle-orm';
import { jobs } from '../../db/schema.js';
/* Jobs a node has or had: running ones, and test jobs and one-shot calls, which go out the moment they are made.
   A queued conversation turn still waits in Hornhoof and goes out later. */
export const ON_NODE = or(eq(jobs.status, 'running'), and(eq(jobs.status, 'queued'), inArray(jobs.kind, ['test', 'call'])));
