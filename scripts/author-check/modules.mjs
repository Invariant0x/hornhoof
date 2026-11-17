import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/* The packages a worktree of a clone shares with the clone: a worktree made for a task need not install what its clone has
   installed from the same lockfile. */

const lockOf = dir => { try { return readFileSync(join(dir, 'package-lock.json')); } catch { return null; } };
const packagesOf = file => { try { return JSON.parse(readFileSync(file, 'utf8')).packages ?? null; } catch { return null; } };
const RECORD = 'node_modules/.package-lock.json';

/* Whether node_modules holds what the folder's lockfile names, by what npm keeps of its install in RECORD: each package at
   the lockfile's version, none the lockfile no longer names, and none missing but one it names for another machine only.
   A workspace's own entry changes with each release and installs nothing. */
export function installedFrom(dir) {
  const wanted = packagesOf(join(dir, 'package-lock.json')), got = packagesOf(join(dir, RECORD));
  if (!wanted || !got) return false;
  const installs = path => path.includes('node_modules/');
  const same = (a, b) => a.version === b.version && a.resolved === b.resolved;
  return Object.entries(wanted).every(([path, entry]) => !installs(path) || (got[path] ? same(entry, got[path]) : entry.optional === true))
    && Object.keys(got).every(path => !installs(path) || path in wanted);
}

/* The clone this worktree was made from, when its packages are installed from this very lockfile, else null. */
export function cloneWithModules(root, git) {
  let common;
  try { common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(); } catch { return null; }
  const clone = dirname(common), ours = lockOf(root), theirs = lockOf(clone);
  if (resolve(clone) === resolve(root) || !ours || !theirs || !ours.equals(theirs)) return null;
  return installedFrom(clone) ? clone : null;
}

/* Each package links to the clone's. A folder of links, a scope or .bin, is made anew with the same links, so that a link to a
   workspace package leads to the worktree's own. A tool's cache, any other entry with a dot, each worktree keeps apart. */
function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name), target = join(to, name), entry = lstatSync(source);
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else if (entry.isDirectory() && (name === '.bin' || name.startsWith('@'))) mirror(source, target);
    else if (!name.startsWith('.')) symlinkSync(source, target);
  }
}

function workspaceFolders(root) {
  let patterns;
  try { patterns = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? []; } catch { return []; }
  return (Array.isArray(patterns) ? patterns : patterns.packages ?? []).flatMap(pattern => {
    if (!pattern.endsWith('/*')) return [pattern];
    const base = pattern.slice(0, -2);
    try { return readdirSync(join(root, base), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(base, entry.name)); } catch { return []; }
  });
}

/* The worktree's node_modules, and each workspace's, from its clone's, in place of what it had. The worktree's own goes in
   place last and whole, with its own copy of npm's record of the install, so one that stopped halfway leaves none and is
   made again. Whether it took them. */
export function shareModules(root, git) {
  const clone = cloneWithModules(root, git);
  if (!clone) return false;
  for (const folder of workspaceFolders(root)) {
    const from = join(clone, folder, 'node_modules'), to = join(root, folder, 'node_modules');
    if (!existsSync(from) || !existsSync(join(root, folder))) continue;
    rmSync(to, { recursive: true, force: true });
    mirror(from, to);
  }
  const staged = join(root, `node_modules.shared-${process.pid}`);
  rmSync(staged, { recursive: true, force: true });
  mirror(join(clone, 'node_modules'), staged);
  copyFileSync(join(clone, RECORD), join(staged, '.package-lock.json'));
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  renameSync(staged, join(root, 'node_modules'));
  return true;
}
