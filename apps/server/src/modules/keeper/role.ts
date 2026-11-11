import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPLICA_FILE } from './become.js';

export const HANDING_FILE = 'handing.json';
const TAKING_FILE = 'taking.json';
/* The phases in which a keeper that wrote a switch down goes on with it when it starts again. */
const TAKING = new Set<unknown>(['go', 'promoted']);
const HANDING = new Set<unknown>(['offered', 'stopped', 'go', 'followed']);

/* The phase a file of the keeper's folder names; none when it is missing or cannot be read. */
function phaseOf(dir: string, file: string): unknown {
  try {
    return (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { phase?: unknown }).phase;
  } catch {
    return undefined;
  }
}

export type KeeperRole = 'worker' | 'follow' | 'lead' | 'taking' | 'handing';

/* Which keeper a machine runs, chosen when the keeper starts. A machine that joined and keeps none of the company's
   data runs a worker's. One that took the go of a planned switch is taking the server over, and one that wrote down
   that it hands the server over goes on with that: both are leading keepers, read from the keeper's own folder. One
   that keeps a copy runs the follow keeper: its keeper marked it with replica.json, or its database follows another
   through an enabled subscription, as on a machine whose control folder was lost. Any other machine holds the
   company's data itself and leads. A change of role starts the keeper anew as the other kind. */
export async function keeperRole(env: NodeJS.ProcessEnv, controlDir: string, dir: string, hasSubscription: () => Promise<boolean>): Promise<KeeperRole> {
  if (env.HORNHOOF_ROLE === 'worker') return 'worker';
  if (TAKING.has(phaseOf(dir, TAKING_FILE))) return 'taking';
  if (HANDING.has(phaseOf(dir, HANDING_FILE))) return 'handing';
  if (existsSync(join(controlDir, REPLICA_FILE))) return 'follow';
  /* A database that cannot be asked now is taken to follow nobody: only the marker or a subscription makes a follower. */
  return (await hasSubscription().catch(() => false)) ? 'follow' : 'lead';
}

/* Whether the database a connection leads to follows another one now. */
export const ENABLED_SUBSCRIPTION = `SELECT EXISTS (SELECT FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subenabled) AS follows`;
