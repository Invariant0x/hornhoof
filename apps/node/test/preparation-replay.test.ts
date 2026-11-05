import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { parseTestEnvironment, type EnvironmentDescription } from '@hornhoof/protocol';
import { readPreparationInputs } from '../src/test-environment.js';
import { inspectReplayFixture, replayCommand } from './preparation-replay.js';

const fixture = fileURLToPath(new URL('./fixtures/preparation-replay/', import.meta.url));

async function privateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hh-replay-audit-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  return root;
}

it('audits the fixed workload without installing or preparing it', async () => {
  const root = await privateFixture();
  const result = await inspectReplayFixture(root);
  expect(result.status).toBe('UNFIT');
  expect(result.measurement).toBe('NOT_RUN');
  expect(result.formatter).toBe('NOT_CONFIGURED');
  expect(result.files.map(file => file.path)).toContain('package-lock.json');
  expect(result.files.map(file => file.path)).not.toContain('node_modules/replay-value/index.cjs');
  expect(await readFile(join(root, 'protocol-source.txt'), 'utf8')).toBe('protocol-v1\n');
});

it('rejects drift in a pinned workload before giving out its command plan', async () => {
  const root = await privateFixture();
  await writeFile(join(root, 'protocol-source.txt'), 'protocol-v2\n');
  await expect(replayCommand(['plan'], root)).rejects.toThrow('Fixture bytes differ');
});

it('rejects missing declared inputs rather than describing a warm hit', async () => {
  const root = await privateFixture();
  await rm(join(root, 'migration.sql'));
  await expect(inspectReplayFixture(root)).rejects.toThrow('Fixture inventory differs');
});

it('does not accept an extra generated result as part of the pinned fixture', async () => {
  const root = await privateFixture();
  await writeFile(join(root, 'prepared.json'), '{}');
  await expect(inspectReplayFixture(root)).rejects.toThrow('Fixture inventory differs');
});

it('refuses measurement even when a caller supplies its own claimed admission', async () => {
  const root = await privateFixture();
  await writeFile(join(root, 'admission.json'), '{"admitted":true}');
  await expect(replayCommand(['measure', '--admission', join(root, 'admission.json')], root)).rejects.toThrow('Measurement is disabled');
  expect(await readFile(join(root, 'protocol-source.txt'), 'utf8')).toBe('protocol-v1\n');
});

it('rejects unknown modes instead of interpreting them as commands', async () => {
  await expect(replayCommand(['npm', 'ci'], fixture)).rejects.toThrow('Use plan');
});

it('rejects a symlink supplied as the fixture root', async () => {
  const root = await privateFixture(), link = `${root}-link`;
  onTestFinished(() => rm(link, { force: true }));
  await symlink(root, link, 'dir');
  await expect(inspectReplayFixture(link)).rejects.toThrow('fixture root');
});

it('rejects a preexisting empty generated output directory', async () => {
  const root = await privateFixture();
  await mkdir(join(root, 'template'));
  await expect(inspectReplayFixture(root)).rejects.toThrow('Fixture inventory differs');
});

it('makes source bytes available to the actual minimal template-input consumer', async () => {
  const root = await privateFixture(), audit = await inspectReplayFixture(root);
  const manifestSource = await readFile(join(root, '.hornhoof/test-environment.json'), 'utf8');
  const description: EnvironmentDescription = {
    version: 1, repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'f'.repeat(64) },
    commitSha: 'bb6882c520a0180f28610fbf8690a2ae52a56050', manifestSource, manifestHash: createHash('sha256').update(manifestSource).digest('hex'),
    manifest: parseTestEnvironment(manifestSource), inputDigests: audit.files.map(file => ({ path: file.path, digest: file.sha256 })), inventory: [], runtimeCapabilities: [],
  };
  await mkdir(join(root, 'protocol/dist'), { recursive: true });
  await writeFile(join(root, 'protocol/dist/index.json'), '{"source":"4240cf02cf97d67c31513ec17ac8df5704e40ad153fbba2e9f5789e399432623"}');
  const context = { checkout: root, cacheRoot: root, profile: 'preparation', completed: ['runtime-build'], signal: new AbortController().signal, deadline: Date.now() + 10_000, log: () => {} };
  const inputs = await readPreparationInputs(description, 'template', context), builder = join(root, 'minimal-builder');
  for (const input of inputs) {
    const destination = join(builder, input.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, input.path), destination);
  }
  expect(await readFile(join(builder, 'protocol-source.txt'), 'utf8')).toBe('protocol-v1\n');
});
