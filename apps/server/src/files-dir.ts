import type { Config } from './config.js';
import { saying } from './locales/index.js';

/* A server in production keeps its files in FILES_DIR, and so does one behind a keeper, from where they go to the other
   machines. With none it would keep them in a folder of one run, which a restart loses, so it does not start, and says
   why in each language it has, English first, before it opens the database. Development and tests without a keeper keep
   that folder. */
export function filesDirRefusal(env: NodeJS.ProcessEnv, config: Pick<Config, 'filesDir' | 'keeper'>): string | null {
  if ((env.NODE_ENV !== 'production' && !config.keeper) || config.filesDir) return null;
  return Object.values(saying(words => words.boot.filesDirMissing)).join('\n');
}
