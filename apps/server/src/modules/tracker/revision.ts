import { sql } from 'drizzle-orm';
import { tasks } from '../../db/schema.js';
/* The next revision of what the tracker keeps, for every change of it. */
export const nextRevision = () => sql`${tasks.trackerRevision} + 1`;
