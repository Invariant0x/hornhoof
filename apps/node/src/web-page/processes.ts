import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* Each call of hh-browse runs its browser on a profile folder of its own, inside a folder named after the call's process.
   The browser's processes carry that profile on their command line, so they are found and ended by it, after the call
   and after a call that died: nothing of another call or another user is touched. */

export type ProcessTable = {
  pids(): number[];
  args(pid: number): string[] | null;
  group(pid: number): number | null;
  owner(pid: number): number | null;
  alive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
};
export type Folders = { list(root: string): string[]; owner(path: string): number | null; remove(path: string): void };

export const FOLDER_PREFIX = 'hh-browse-';
const FOLDER = /^hh-browse-(\d+)-/;
export const profileOf = (dir: string): string => join(dir, 'profile');

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export const systemProcesses: ProcessTable = {
  pids: () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number),
  args: pid => read(`/proc/${pid}/cmdline`)?.split('\0').filter(Boolean) ?? null,
  /* The fifth field of stat, after the name in parentheses, which may itself hold spaces. */
  group: pid => {
    const stat = read(`/proc/${pid}/stat`);
    const fields = stat?.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields?.[2] ? Number(fields[2]) : null;
  },
  owner: pid => {
    try {
      return statSync(`/proc/${pid}`).uid;
    } catch {
      return null;
    }
  },
  alive: pid => lstatSync(`/proc/${pid}`, { throwIfNoEntry: false }) !== undefined,
  kill: (pid, signal) => process.kill(pid, signal),
};

export const systemFolders: Folders = {
  list: root => {
    try {
      return readdirSync(root);
    } catch {
      return [];
    }
  },
  owner: path => lstatSync(path, { throwIfNoEntry: false })?.uid ?? null,
  remove: path => rmSync(path, { recursive: true, force: true }),
};

/* Ends, with all of its group, every process of this user that runs on the profile; a browser leads its own group. */
export function reapProfile(profile: string, table: ProcessTable, uid: number): number[] {
  const flag = `--user-data-dir=${profile}`;
  const found = table.pids().filter(pid => table.owner(pid) === uid && (table.args(pid) ?? []).includes(flag));
  for (const pid of found) {
    try {
      table.kill(table.group(pid) === pid ? -pid : pid, 'SIGKILL');
    } catch {
      /* Already gone. */
    }
  }
  return found;
}

/* Folders of calls of this user whose process is gone, with whatever still runs on their profile. */
export function sweepStale(root: string, folders: Folders, table: ProcessTable, uid: number): string[] {
  const stale: string[] = [];
  for (const name of folders.list(root)) {
    const pid = FOLDER.exec(name)?.[1];
    const path = join(root, name);
    if (!pid || table.alive(Number(pid)) || folders.owner(path) !== uid) continue;
    reapProfile(profileOf(path), table, uid);
    folders.remove(path);
    stale.push(path);
  }
  return stale;
}
