import { describe, expect, it } from 'vitest';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { discoverEnvironment } from '../src/test-discovery.js';
import type { CommitTree } from '../src/test-mirror.js';

const tree = (files: Record<string, string>): Pick<CommitTree, 'entries' | 'readBlob'> => ({
  entries: Object.keys(files).map(path => ({ path, mode: '100644', oid: 'b'.repeat(40) })),
  readBlob: async path => Buffer.from(files[path]!),
});
const pkg = (over: object = {}) => JSON.stringify({ name: 'shop', scripts: { test: 'vitest run' }, ...over });

describe('finding a test environment by a repository\'s language', () => {
  it('brings a JavaScript project up from its lock file, sharing its dependencies read-only', async () => {
    const manifest = await discoverEnvironment(tree({ 'package.json': pkg(), 'package-lock.json': '{}' }));
    expect(parseTestEnvironment(JSON.stringify(manifest))).toEqual(manifest);
    expect(manifest.dependencies).toMatchObject({ adapter: 'npm', cache: 'link', inputs: ['package.json', 'package-lock.json'], paths: ['node_modules'] });
    expect(manifest.dependencies.install[0]).toEqual({ program: 'npm', args: ['ci', '--no-audit', '--no-fund'], cwd: '.' });
    expect(manifest.suites).toMatchObject([{ id: 'javascript', split: { kind: 'whole-package' }, run: { program: 'npm', args: ['test'] } }]);
    expect(manifest.profiles).toEqual([{ id: 'default', requiredSuiteIds: ['javascript'] }]);
  });

  it('counts each workspace package, as its own dependencies and as an input', async () => {
    const manifest = await discoverEnvironment(tree({ 'package.json': pkg({ workspaces: ['apps/*', 'packages/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': '{}', 'packages/ui/package.json': '{}', 'examples/x/package.json': '{}', '.npmrc': '' }));
    expect(manifest.dependencies.paths).toEqual(['node_modules', 'apps/web/node_modules', 'packages/ui/node_modules']);
    expect(manifest.dependencies.inputs).toEqual(['package.json', 'package-lock.json', '.npmrc', 'apps/web/package.json', 'packages/ui/package.json']);
    expect(manifest.dependencies.install[1]).toEqual({ program: 'mkdir', args: ['-p', 'node_modules', 'apps/web/node_modules', 'packages/ui/node_modules'], cwd: '.' });
  });

  it('runs the tests of the workspaces when the root has none', async () => {
    const manifest = await discoverEnvironment(tree({ 'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' }));
    expect(manifest.suites[0]!.run.args).toEqual(['test', '--workspaces']);
  });

  it.each([
    ['pnpm-lock.yaml', '', ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--package-import-method=copy']],
    ['yarn.lock', '# yarn lockfile v1\n', ['corepack', 'yarn', 'install', '--frozen-lockfile']],
    ['yarn.lock', '__metadata:\n  version: 8\n', ['corepack', 'yarn', 'install', '--immutable']],
  ])('uses the package manager of %s', async (lock, text, command) => {
    const manifest = await discoverEnvironment(tree({ 'package.json': pkg(), [lock]: text }));
    const [first] = manifest.dependencies.install;
    expect([first!.program, ...first!.args]).toEqual(command);
  });

  it('reads pnpm\'s own list of workspaces', async () => {
    const manifest = await discoverEnvironment(tree({ 'package.json': pkg(), 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - \"!apps/old\"\n", 'apps/web/package.json': '{}' }));
    expect(manifest.dependencies.paths).toEqual(['node_modules', 'apps/web/node_modules']);
    expect(manifest.dependencies.inputs).toContain('pnpm-workspace.yaml');
  });

  it('refuses a project with no lock file, as machines could get different dependencies', async () => {
    await expect(discoverEnvironment(tree({ 'package.json': pkg() }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('lock file') as string });
  });

  it('says so when package.json cannot be read', async () => {
    await expect(discoverEnvironment(tree({ 'package.json': 'not json', 'package-lock.json': '{}' }))).rejects.toMatchObject({ code: 'environment_invalid' });
  });

  it('brings a Python project up from its requirements, leaving the tool that installs them behind', async () => {
    const manifest = await discoverEnvironment(tree({ 'requirements.txt': 'flask==3', 'requirements-dev.txt': 'pytest', 'tests/test_a.py': '' }));
    expect(parseTestEnvironment(JSON.stringify(manifest))).toEqual(manifest);
    expect(manifest.dependencies).toMatchObject({ adapter: 'pip', cache: 'link', inputs: ['requirements.txt', 'requirements-dev.txt'], paths: ['.hornhoof/python'], env: { PYTHONPATH: '.hornhoof/python' } });
    expect(manifest.dependencies.install.at(-1)!.args).toEqual(['-m', 'pip', 'install', '--no-cache-dir', '--target', '.hornhoof/python', '-r', 'requirements.txt', '-r', 'requirements-dev.txt', 'pytest']);
    expect(manifest.suites[0]!.run).toEqual({ program: 'python3', args: ['-m', 'pytest'], cwd: '.' });
  });

  it('takes what pyproject.toml declares, without installing the project over its own checkout', async () => {
    const manifest = await discoverEnvironment(tree({ 'pyproject.toml': '[project]\nname="shop"\n', 'src/shop/__init__.py': '' }));
    expect(manifest.dependencies.inputs).toEqual(['pyproject.toml']);
    expect(manifest.dependencies.install.at(-1)!.args).toEqual(['-m', 'pip', 'install', '--no-cache-dir', '--target', '.hornhoof/python', '-r', '.hornhoof/requirements.txt', 'pytest']);
    expect(manifest.suites[0]!.run.args).toEqual(['-m', 'pytest', '-o', 'pythonpath=src']);
  });

  it('brings both up in a repository of two languages', async () => {
    const manifest = await discoverEnvironment(tree({ 'package.json': pkg(), 'package-lock.json': '{}', 'requirements.txt': '' }));
    expect(manifest.dependencies.adapter).toBe('npm.pip');
    expect(manifest.suites.map(suite => suite.id)).toEqual(['javascript', 'python']);
    expect(manifest.profiles[0]!.requiredSuiteIds).toEqual(['javascript', 'python']);
    expect(manifest.dependencies.paths).toEqual(['node_modules', '.hornhoof/python']);
    expect(parseTestEnvironment(JSON.stringify(manifest))).toEqual(manifest);
  });

  it.each([['go.mod', 'Go'], ['Cargo.toml', 'Rust'], ['composer.json', 'PHP'], ['Gemfile', 'Ruby'], ['pom.xml', 'Java'], ['build.gradle.kts', 'Java']])('recognizes %s and says machines lack its tools', async (file, language) => {
    await expect(discoverEnvironment(tree({ [file]: '' }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining(`${language} tools`) as string });
  });

  it('says plainly when it finds no language at all', async () => {
    await expect(discoverEnvironment(tree({ 'README.md': 'Notes' }))).rejects.toMatchObject({ code: 'environment_missing' });
  });

  it('refuses to describe more workspace packages than fit', async () => {
    const files: Record<string, string> = { 'package.json': pkg({ workspaces: ['p/*'] }), 'package-lock.json': '{}' };
    for (let n = 0; n < 300; n++) files[`p/${n}/package.json`] = '{}';
    await expect(discoverEnvironment(tree(files))).rejects.toMatchObject({ code: 'environment_unsupported' });
  });
});
