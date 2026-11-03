import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

function workspaceManifests(root, pattern) {
  if (!/^[\w.-]+\/\*$/.test(pattern)) throw new Error(`Unsupported workspace pattern: ${pattern}`);
  const folder = join(root, pattern.slice(0, -2));
  return readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => join(folder, e.name, 'package.json')).filter(existsSync).sort();
}

export function readProject(root) {
  const path = join(root, 'package.json'), data = readJson(path);
  if (!Array.isArray(data.workspaces)) throw new Error('package.json must list its workspaces.');
  const paths = data.workspaces.flatMap(pattern => workspaceManifests(root, pattern));
  return { root, version: data.version, manifests: [{ path, data }, ...paths.map(path => ({ path, data: readJson(path) }))] };
}

/* Prepare every JSON value before changing a file, including all workspace lock entries. */
export function writeVersion(project, version) {
  const path = join(project.root, 'package-lock.json'), lock = readJson(path);
  const packages = { ...lock.packages };
  for (const manifest of project.manifests) {
    const key = relative(project.root, dirname(manifest.path)).split(sep).join('/');
    if (!packages[key]) throw new Error(`package-lock.json has no workspace entry: ${key || '.'}`);
    packages[key] = { ...packages[key], version };
  }
  const output = [...project.manifests.map(m => ({ path: m.path, data: { ...m.data, version } })),
    { path, data: { ...lock, version, packages } }];
  for (const file of output) writeFileSync(file.path, JSON.stringify(file.data, null, 2) + '\n');
}
