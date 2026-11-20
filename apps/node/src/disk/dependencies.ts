import { join } from 'node:path';
import { folderBytes } from './clean.js';

/* git in a clone, as the node runs it for the clone's agent: its output, or the failure. */
export type CloneGit = (args: string[], cwd: string) => Promise<string>;

const DEPENDENCIES = /(^|\/)node_modules\/$/;

/* Takes away the installed dependencies of a clone, which come back with one install: every node_modules folder git ignores
   there, at any depth. git itself lists and removes them, as the clone's agent, so nothing else in the clone goes: no change
   that is not committed, no commit, no other file git ignores, and never what a link points to. It says how many bytes that
   freed. */
export async function dropDependencies(tree: string, git: CloneGit): Promise<number> {
  const listed = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], tree);
  let freed = 0;
  for (const folder of listed.split('\0').filter(entry => DEPENDENCIES.test(entry))) {
    const path = join(tree, folder);
    const before = await folderBytes(path);
    await git(['clean', '-ffdXq', '--', folder], tree);
    freed += Math.max(0, before - (await folderBytes(path)));
  }
  return freed;
}
