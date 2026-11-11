import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { queryOf } from './leader.js';
import { KEPT_NAME, keptSource, type MergeSource } from './source.js';

/* What the CEO chose for the database a restore sets aside, written before the order goes: the app's memory does not
   outlive the swap. It is in the control folder, for this container's user alone. */
export const CHOICE_FILE = 'restore-choice.json';
export type Choice = { attempt: string; bringBack: boolean };

export function writeChoice(controlDir: string, choice: Choice): void {
  const path = join(controlDir, CHOICE_FILE);
  writeFileSync(`${path}.new`, JSON.stringify(choice), { mode: 0o600 });
  renameSync(`${path}.new`, path);
}

/* The choice that was written, or null when there is none that can be read. */
export function readChoice(controlDir: string): Choice | null {
  try {
    const said = JSON.parse(readFileSync(join(controlDir, CHOICE_FILE), 'utf8')) as Partial<Choice>;
    return typeof said.attempt === 'string' && typeof said.bringBack === 'boolean' ? { attempt: said.attempt, bringBack: said.bringBack } : null;
  } catch {
    return null;
  }
}

export function dropChoice(controlDir: string): void {
  rmSync(join(controlDir, CHOICE_FILE), { force: true });
}

/* The databases restores set aside on this machine's own Postgres. list: their names. open: one of them as a merge's
   source, with its connections turned on first, as a restore leaves them off. drop: removes one for good. */
export type KeptDatabases = {
  list(): Promise<string[]>;
  open(name: string, label: string): Promise<MergeSource>;
  drop(name: string): Promise<void>;
};

export function keptDatabases(db: Db, config: Config): KeptDatabases {
  const q = queryOf(db);
  /* The statement with the name quoted by the database itself; a name that is no kept database's gets none. */
  const named = async (statement: string, name: string): Promise<string> => {
    if (!KEPT_NAME.test(name)) throw new Error('This is not a database a restore kept.');
    const [made] = await q<{ text: string }>('SELECT format($1, $2::text) AS text', [statement, name]);
    return made!.text;
  };
  return {
    list: async () => (await q<{ name: string }>("SELECT datname AS name FROM pg_database WHERE datname LIKE 'hornhoof_before_%' ORDER BY datname")).map(row => row.name).filter(name => KEPT_NAME.test(name)),
    open: async (name, label) => {
      await q(await named('ALTER DATABASE %I WITH ALLOW_CONNECTIONS true', name));
      return keptSource(config, name, label);
    },
    drop: async name => {
      await q(await named('DROP DATABASE IF EXISTS %I', name));
    },
  };
}
