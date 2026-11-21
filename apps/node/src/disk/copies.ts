import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DISK_IGNORED_MAX, type TaskStates } from '@hornhoof/protocol';
import { closedCopies, type CloneRun } from '../task-copies.js';
import { folderBytes, type Cleaner, type Stay } from './clean.js';
import { runDedupeForOwner, type DedupeTarget } from './dedupe.js';
import { dropDependencies } from './dependencies.js';
import type { StoreOwner } from './store.js';

/* A finished task's working copy that stays because work in it is on no remote: whose it is, where in that agent's folder,
   which task, what it takes, and why, for a person to see. */
export type KeptCopy = Stay & { task: number };

type Options = {
  dir: string;
  /* git as the agents' user; null where it would run as root, and then nothing goes. */
  git: CloneRun | null;
  /* The company's open tasks as the last turn on this node named them; null before any did, and then nothing goes. */
  tasks: () => TaskStates | null;
  /* Per-UID shared package store for content-addressed hard-link dedup and CAS GC; omitted in tests that skip dedup. */
  store?: string | null;
  /* The unprivileged user whose workspaces are deduplicated (never root). */
  owner?: StoreOwner;
  /* When true (disk below threshold), unreferenced CAS entries are pruned immediately instead of waiting for retention. */
  aggressive?: () => boolean;
};

const DEPENDENCIES = /(^|\/)node_modules\/$/;

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const folders = async (path: string): Promise<string[]> => {
  const names = await readdir(path).catch(() => [] as string[]);
  const realFolders: string[] = [];
  for (const name of names) {
    const st = await lstat(join(path, name)).catch(() => null);
    if (st?.isDirectory()) realFolders.push(name);
  }
  return realFolders;
};

const isClone = async (path: string) => Boolean((await lstat(join(path, '.git')).catch(() => null))?.isDirectory());

async function cloneNodeModules(clone: string, agentDir: string, git: CloneRun): Promise<DedupeTarget[]> {
  const folder = real(agentDir);
  if (!folder) return [];
  const listed = await git(['worktree', 'list', '--porcelain', '-z'], clone).catch(() => '');
  const trees = listed
    .split('\0\0')
    .map(record => record.split('\0').filter(Boolean))
    .filter(fields => fields[0]?.startsWith('worktree ') && !fields.some(f => f === 'prunable' || f.startsWith('prunable ')))
    .map(fields => fields[0]!.slice('worktree '.length));
  const targets: DedupeTarget[] = [];
  for (const tree of trees) {
    const at = real(tree);
    if (!at || !at.startsWith(folder + sep)) continue;
    const ignored = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], tree).catch(() => '');
    for (const entry of ignored.split('\0').filter(name => DEPENDENCIES.test(name))) {
      targets.push({ rootDir: tree, nodeModulesDir: join(tree, entry) });
    }
  }
  return targets;
}

/* The working copies of the agents on a node, in work/agents/<agent>: each clone's worktrees of finished tasks go once
   everything in them is on the remote, in every clone of every agent and between turns too. One that stays for work on no
   remote loses only its installed dependencies, and is named for the card. Remaining active clones' ignored node_modules
   are hard-linked into the per-UID shared store so multiple clones do not duplicate packages. An agent's folder that is a
   link is never followed. */
export function workingCopies({ dir, git, tasks, store = null, owner = { user: null, home: null }, aggressive }: Options): Cleaner & { kept(): KeptCopy[] } {
  const agents = join(dir, 'work', 'agents');
  let kept: KeptCopy[] = [];
  return {
    part: 'workingCopies',
    size: () => folderBytes(join(dir, 'work')),
    kept: () => [...kept],
    async clean() {
      if (!git) return 0;
      const states = tasks();
      let freed = 0;
      const stays: KeptCopy[] = [];
      const dedupeTargets: DedupeTarget[] = [];
      for (const agent of await folders(agents)) {
        const agentDir = join(agents, agent);
        for (const name of await folders(agentDir)) {
          const clone = join(agentDir, name);
          if (!(await isClone(clone))) continue;
          if (states) {
            const sizes = new Map<string, number>();
            const { copies } = await closedCopies(clone, agentDir, states, git, async path => {
              sizes.set(path, await folderBytes(path).catch(() => 0));
            });
            for (const copy of copies) {
              if (copy.removed) freed += sizes.get(copy.path) ?? 0;
              if (copy.removed || copy.why === 'locked' || copy.why === 'failed') continue;
              freed += await dropDependencies(copy.path, git).catch(() => 0);
              const ignored = copy.ignored ? { ignored: copy.ignored.slice(0, DISK_IGNORED_MAX) } : {};
              stays.push({ agent, path: relative(agentDir, copy.path), task: copy.task, bytes: await folderBytes(copy.path).catch(() => 0), why: copy.why, ...ignored });
            }
          }
          if (store) dedupeTargets.push(...(await cloneNodeModules(clone, agentDir, git)));
        }
      }
      if (states) kept = stays.sort((a, b) => b.bytes - a.bytes);
      if (store) {
        const deduped = await runDedupeForOwner({
          store,
          targets: dedupeTargets,
          owner,
          prune: { aggressive: aggressive?.() ?? false },
        }).catch(() => ({ hashed: 0, linked: 0, freed: 0, exdev: false, gcPruned: 0, gcFreed: 0 }));
        freed += deduped.freed + deduped.gcFreed;
      }
      return freed;
    },
  };
}
