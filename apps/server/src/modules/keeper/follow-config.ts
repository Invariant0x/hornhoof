import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretOf } from '../../config.js';
import { KEEPER_DIR } from './machine-keys.js';
import { PEERS_FILE } from './worker.js';
import { RUN_AGAIN, workerConfig, type WorkerConfig } from './worker-config.js';

/* What the keeper of a machine that keeps a copy is started with: a worker's lines, and with them the company's secret
   and the way into this machine's own database, which a copy holds. A worker's keeper never loads this file. */
export type FollowConfig = WorkerConfig & { secret: Buffer; databaseUrl: string };

/* The address of the company's link in the view of the network this keeper keeps in its folder; none without one. */
function linkIn(dir: string): string | undefined {
  try {
    const view = JSON.parse(readFileSync(join(dir, PEERS_FILE), 'utf8')) as { link?: { url?: unknown } | null };
    return typeof view.link?.url === 'string' ? view.link.url : undefined;
  } catch {
    return undefined;
  }
}

/* The server to reach comes from the settings the join wrote; a machine that never joined, as the one the company was
   installed on, has none there, and once it follows another it takes the company's link from the view it keeps. */
export function followConfig(env: NodeJS.ProcessEnv, log: (line: string) => void = () => undefined, dir: string = KEEPER_DIR): FollowConfig {
  if (!env.DATABASE_URL) throw new Error(`DATABASE_URL is not set, so this machine cannot keep a copy. ${RUN_AGAIN}`);
  const joinServer = env.HORNHOOF_JOIN_SERVER || linkIn(dir);
  return { ...workerConfig({ ...env, HORNHOOF_JOIN_SERVER: joinServer }, log), secret: secretOf(env), databaseUrl: env.DATABASE_URL };
}
