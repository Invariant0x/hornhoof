import { secretOf } from '../../config.js';
import { RUN_AGAIN, workerConfig, type WorkerConfig } from './worker-config.js';

/* What the keeper of a machine that keeps a copy is started with: a worker's lines, and with them the company's secret
   and the way into this machine's own database, which a copy holds. A worker's keeper never loads this file. */
export type FollowConfig = WorkerConfig & { secret: Buffer; databaseUrl: string };

export function followConfig(env: NodeJS.ProcessEnv, log: (line: string) => void = () => undefined): FollowConfig {
  if (!env.DATABASE_URL) throw new Error(`DATABASE_URL is not set, so this machine cannot keep a copy. ${RUN_AGAIN}`);
  return { ...workerConfig(env, log), secret: secretOf(env), databaseUrl: env.DATABASE_URL };
}
