import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DISK_IGNORED_MAX, type TaskStates } from '@hornhoof/protocol';
import { closedCopies, standaloneClosedCopy, taskOfTree, treesOf, type ClosedCopy, type CloneRun, type Tree } from '../task-copies.js';
import { folderBytes, type Cleaner, type ListedCopy, type Stay } from './clean.js';
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

async function liveCloneTrees(clone: string, agentDir: string, git: CloneRun): Promise<Tree[]> {
  const folder = real(agentDir);
  if (!folder) return [];
  const listed = await git(['worktree', 'list', '--porcelain', '-z'], clone).catch(() => '');
  return treesOf(listed).filter(tree => {
    if (tree.prunable) return false;
    const at = real(tree.path);
    return Boolean(at && at.startsWith(folder + sep));
  });
}

async function treeNodeModules(trees: Tree[], git: CloneRun): Promise<DedupeTarget[]> {
  const targets: DedupeTarget[] = [];
  for (const tree of trees) {
    const ignored = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], tree.path).catch(() => '');
    for (const entry of ignored.split('\0').filter(name => DEPENDENCIES.test(name))) {
      targets.push({ rootDir: tree.path, nodeModulesDir: join(tree.path, entry) });
    }
  }
  return targets;
}

/* The working copies of the agents on a node, in work/agents/<agent>: each clone's worktrees (and standalone task clones) of
   finished and cancelled tasks go once everything in them is on the remote, in every clone of every agent and between turns
   too. One that stays for work on no remote loses only its installed dependencies, and is named for the card. Remaining active
   working copies are measured largest-first for the machine card, and their ignored node_modules are hard-linked into the
   per-UID shared store so multiple clones do not duplicate packages. An agent's folder that is a link is never followed. */
export function workingCopies({ dir, git, tasks, store = null, owner = { user: null, home: null }, aggressive }: Options): Cleaner & { kept(): KeptCopy[]; copies(): ListedCopy[] } {
  const agents = join(dir, 'work', 'agents');
  let kept: KeptCopy[] = [];
  let listed: ListedCopy[] = [];
  return {
    part: 'workingCopies',
    size: () => folderBytes(join(dir, 'work')),
    kept: () => [...kept],
    copies: () => [...listed],
    async clean() {
      if (!git) return 0;
      const states = tasks();
      let freed = 0;
      let removedAny = false;
      const stays: KeptCopy[] = [];
      const foundCopies: ListedCopy[] = [];
      const seenCopies = new Set<string>();
      const dedupeTargets: DedupeTarget[] = [];
      const recordOutcome = async (agent: string, agentDir: string, copy: ClosedCopy, sizes: Map<string, number>) => {
        if (copy.removed) {
          freed += sizes.get(copy.path) ?? 0;
          removedAny = true;
          return;
        }
        if (copy.why === 'locked' || copy.why === 'failed') return;
        freed += await dropDependencies(copy.path, git).catch(() => 0);
        const ignored = copy.ignored ? { ignored: copy.ignored.slice(0, DISK_IGNORED_MAX) } : {};
        stays.push({ agent, path: relative(agentDir, copy.path), task: copy.task, bytes: await folderBytes(copy.path).catch(() => 0), why: copy.why, ...ignored });
      };
      for (const agent of await folders(agents)) {
        const agentDir = join(agents, agent);
        for (const name of await folders(agentDir)) {
          const clone = join(agentDir, name);
          if (!(await isClone(clone))) continue;
          if (states) {
            const sizes = new Map<string, number>();
            const measure = async (path: string) => {
              sizes.set(path, await folderBytes(path).catch(() => 0));
            };
            const standalone = await standaloneClosedCopy(clone, agentDir, states, git, measure);
            if (standalone) {
              await recordOutcome(agent, agentDir, standalone, sizes);
              if (standalone.removed) continue;
            }
            const { copies } = await closedCopies(clone, agentDir, states, git, measure);
            for (const copy of copies) await recordOutcome(agent, agentDir, copy, sizes);
          }
          const trees = await liveCloneTrees(clone, agentDir, git);
          for (let index = 0; index < trees.length; index++) {
            const tree = trees[index]!;
            const relPath = relative(agentDir, tree.path);
            const key = `${agent}\0${relPath}`;
            if (seenCopies.has(key)) continue;
            seenCopies.add(key);
            const taskNum = taskOfTree(tree, index === 0 ? '' : name);
            foundCopies.push({ agent, path: relPath, task: taskNum > 0 ? taskNum : null, bytes: await folderBytes(tree.path).catch(() => 0) });
          }
          if (store) dedupeTargets.push(...(await treeNodeModules(trees, git)));
        }
      }
      if (states) kept = stays.sort((a, b) => b.bytes - a.bytes);
      listed = foundCopies.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
      if (store) {
        const deduped = await runDedupeForOwner({
          store,
          targets: dedupeTargets,
          owner,
          prune: { aggressive: removedAny || (aggressive?.() ?? false) },
        }).catch(() => ({ hashed: 0, linked: 0, freed: 0, exdev: false, gcPruned: 0, gcFreed: 0 }));
        freed += deduped.freed + deduped.gcFreed;
      }
      return freed;
    },
  };
}
