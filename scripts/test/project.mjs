import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';

export const manifests = ['package.json', 'packages/protocol/package.json', 'apps/server/package.json', 'apps/node/package.json', 'apps/web/package.json'];
const roots = new Set();
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function project(version = '0.5.0', branch = 'turn-5') {
  const root = mkdtempSync(join(tmpdir(), 'release-test-'));
  roots.add(root);
  const packages = {};
  for (const path of manifests) {
    const folder = path.slice(0, -'package.json'.length);
    mkdirSync(join(root, folder), { recursive: true });
    const data = { name: folder || 'project', version };
    if (!folder) data.workspaces = ['packages/*', 'apps/*'];
    writeJson(join(root, path), data);
    packages[folder.replace(/\/$/, '')] = { ...data };
  }
  packages['node_modules/example-dependency'] = { version: '9.8.7' };
  writeJson(join(root, 'package-lock.json'), { name: 'project', version, lockfileVersion: 3, packages });
  writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-11-04\n\n### Fixed\n\n- A checkout issue.\n`);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--quiet', `--initial-branch=${branch}`);
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'release@example.test');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Create release fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = (script, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], { cwd: root, encoding: 'utf8' });
  return { root, git, run, versions: () => manifests.map(p => readJson(join(root, p)).version) };
}

export function cleanProjects() {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
}
