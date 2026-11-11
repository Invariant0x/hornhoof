import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPLICA_FILE } from './become.js';

/* Which keeper a machine runs, chosen when the keeper starts. A machine that joined and keeps none of the company's
   data runs a worker's. One that keeps a copy runs the follow keeper: its keeper marked it with replica.json, or its
   database follows another through an enabled subscription, as on a machine whose control folder was lost. Any other
   machine holds the company's data itself and leads. A change of role starts the keeper anew as the other kind. */
export async function keeperRole(env: NodeJS.ProcessEnv, controlDir: string, hasSubscription: () => Promise<boolean>): Promise<'worker' | 'follow' | 'lead'> {
  if (env.HORNHOOF_ROLE === 'worker') return 'worker';
  if (existsSync(join(controlDir, REPLICA_FILE))) return 'follow';
  /* A database that cannot be asked now is taken to follow nobody: only the marker or a subscription makes a follower. */
  return (await hasSubscription().catch(() => false)) ? 'follow' : 'lead';
}

/* Whether the database a connection leads to follows another one now. */
export const ENABLED_SUBSCRIPTION = `SELECT EXISTS (SELECT FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subenabled) AS follows`;
