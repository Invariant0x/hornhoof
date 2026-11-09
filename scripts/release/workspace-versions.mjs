import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* Our own versions: each release moves the version of the root package.json, of each workspace's package.json and of the
   lockfile's entries for them, and nothing a test or a build reads changes with them. GitHub's choice of tests and the
   Docker builds look at these files with them set to this one. */
export const SET_ASIDE = '0.0.0';
const LOCK = 'package-lock.json';

/* The root package.json, the lockfile, or the package.json of a workspace, by the root's patterns: a folder of workspaces each, as "apps/*". */
export function isOwnManifest(path, workspaces) {
  if (path === 'package.json' || path === LOCK) return true;
  const [folder, , file, ...rest] = path.split('/');
  return file === 'package.json' && rest.length === 0 && workspaces.includes(`${folder}/*`);
}

const aside = entry => (entry && typeof entry === 'object' && 'version' in entry ? { ...entry, version: SET_ASIDE } : entry);

/* One of them with our own versions set aside. In the lockfile those are its own and those of the entries for the root
   and the workspaces, the only entries outside node_modules. */
export function withoutVersions(path, text) {
  const data = aside(JSON.parse(text));
  if (path === LOCK && data.packages) {
    data.packages = Object.fromEntries(Object.entries(data.packages).map(([key, entry]) => [key, key.split('/').includes('node_modules') ? entry : aside(entry)]));
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function sameWithout(path, [before, after]) {
  try { return withoutVersions(path, before) === withoutVersions(path, after); } catch { return false; }
}

/* The changes left once our package files where only our own versions moved are taken out, and the paths taken out. read
   gives a path's text before and after. A file that came, went or moved stays a change. */
export function versionMoves(changes, workspaces, read) {
  const moved = changes.filter(change => change.kind === 'modified' && isOwnManifest(change.path, workspaces) && sameWithout(change.path, read(change.path)));
  return { changes: changes.filter(change => !moved.includes(change)), moved: moved.map(change => change.path) };
}

/* Sets our own versions aside in the package files under root, as the Docker builds do before npm ci, so that a release
   installs nothing again. */
export function setAside(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifests = workspaces.flatMap(pattern => readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `${pattern.slice(0, -2)}/${entry.name}/package.json`));
  for (const path of ['package.json', LOCK, ...manifests]) {
    let text;
    try { text = readFileSync(join(root, path), 'utf8'); } catch { continue; }
    writeFileSync(join(root, path), withoutVersions(path, text));
  }
}
