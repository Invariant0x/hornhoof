import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretOf } from '../../config.js';
import { KEEPER_DIR } from './machine-keys.js';
import { PEERS_FILE } from './worker.js';
import { RUN_AGAIN, workerConfig, type WorkerConfig } from './worker-config.js';

/* What the keeper of a machine that keeps a copy is started with: a worker's lines, and with them the company's secret
   and the way into this machine's own database, which a copy holds. A worker's keeper never loads this file. */
export type FollowConfig = WorkerConfig & { secret: Buffer; databaseUrl: string };

type KeptView = { link?: { url?: unknown; hidden?: unknown } | null; data?: unknown };

/* The address this keeper reaches the company's server at, from the view of the network it keeps in its folder: the
   company's link, or, when that is a hidden name, at which only who holds the lease is answered, or there is none,
   the web port of the first other machine that holds the data and says an address. None without either. own: the id
   this machine's keeper runs under. */
function serverIn(dir: string, own: string | undefined): string | undefined {
  try {
    const view = JSON.parse(readFileSync(join(dir, PEERS_FILE), 'utf8')) as KeptView;
    if (typeof view.link?.url === 'string' && view.link.hidden !== true) return view.link.url;
    for (const machine of Array.isArray(view.data) ? (view.data as { networkId?: unknown; addresses?: unknown; webPort?: unknown }[]) : []) {
      if (own && machine.networkId === own) continue;
      const address = Array.isArray(machine.addresses) ? machine.addresses.find((one): one is string => typeof one === 'string' && one.length > 0) : undefined;
      if (address && typeof machine.webPort === 'number') return `http://${address}:${machine.webPort}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/* The server to reach comes from the settings the join wrote; a machine that never joined, as the one the company was
   installed on, has none there, and once it follows another it takes the company's link from the view it keeps, or,
   past a hidden name, the address of a machine that holds the data. */
export function followConfig(env: NodeJS.ProcessEnv, log: (line: string) => void = () => undefined, dir: string = KEEPER_DIR): FollowConfig {
  if (!env.DATABASE_URL) throw new Error(`DATABASE_URL is not set, so this machine cannot keep a copy. ${RUN_AGAIN}`);
  const joinServer = env.HORNHOOF_JOIN_SERVER || serverIn(dir, env.HORNHOOF_MACHINE_ID);
  return { ...workerConfig({ ...env, HORNHOOF_JOIN_SERVER: joinServer }, log), secret: secretOf(env), databaseUrl: env.DATABASE_URL };
}
