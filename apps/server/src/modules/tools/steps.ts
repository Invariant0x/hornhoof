import { ne } from 'drizzle-orm';
import { jobs } from '../../db/schema.js';

/* A job that is no step of the tools: a step answers one request of an agent's program that called its tools with no turn
   running, and ends with it. It is no work that holds an employee, counts as working or waits for a node. */
export const notStep = ne(jobs.kind, 'tools');
