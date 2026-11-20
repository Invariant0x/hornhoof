import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { TaskStates } from '@hornhoof/protocol';
import { closedCopies, type CloneRun } from '../task-copies.js';
import { folderBytes, type Cleaner } from './clean.js';
import { dropDependencies } from './dependencies.js';

/* A finished task's working copy that stays because work in it is on no remote: whose it is, where in that agent's folder,
   which task, what it takes, and why, for a person to see. */
export type KeptCopy = { agent: string; path: string; task: number; bytes: number; why: 'uncommitted' | 'unpushed' };

type Options = {
  dir: string;
  /* git as the agents' user; null where it would run as root, and then nothing goes. */
  git: CloneRun | null;
  /* The company's open tasks as the last turn on this node named them; null before any did, and then nothing goes. */
  tasks: () => TaskStates | null;
};

const folders = async (path: string): Promise<string[]> => {
  const names = await readdir(path).catch(() => [] as string[]);
  const real: string[] = [];
  for (const name of names) {
    const st = await lstat(join(path, name)).catch(() => null);
    if (st?.isDirectory()) real.push(name);
  }
  return real;
};

const isClone = async (path: string) => Boolean((await lstat(join(path, '.git')).catch(() => null))?.isDirectory());

/* The working copies of the agents on a node, in work/agents/<agent>: each clone's worktrees of finished tasks go once
   everything in them is on the remote, in every clone of every agent and between turns too. One that stays for work on no
   remote loses only its installed dependencies, and is named for the card. An agent's folder that is a link is never
   followed. */
export function workingCopies({ dir, git, tasks }: Options): Cleaner & { kept(): KeptCopy[] } {
  const agents = join(dir, 'work', 'agents');
  let kept: KeptCopy[] = [];
  return {
    part: 'workingCopies',
    size: () => folderBytes(join(dir, 'work')),
    kept: () => [...kept],
    async clean() {
      const states = tasks();
      if (!git || !states) return 0;
      let freed = 0;
      const stays: KeptCopy[] = [];
      for (const agent of await folders(agents)) {
        const agentDir = join(agents, agent);
        for (const name of await folders(agentDir)) {
          const clone = join(agentDir, name);
          if (!(await isClone(clone))) continue;
          const sizes = new Map<string, number>();
          const { copies } = await closedCopies(clone, agentDir, states, git, async path => {
            sizes.set(path, await folderBytes(path));
          });
          for (const copy of copies) {
            if (copy.removed) freed += sizes.get(copy.path) ?? 0;
            if (copy.removed || (copy.why !== 'uncommitted' && copy.why !== 'unpushed')) continue;
            freed += await dropDependencies(copy.path, git).catch(() => 0);
            stays.push({ agent, path: relative(agentDir, copy.path), task: copy.task, bytes: await folderBytes(copy.path), why: copy.why });
          }
        }
      }
      kept = stays.sort((a, b) => b.bytes - a.bytes);
      return freed;
    },
  };
}
