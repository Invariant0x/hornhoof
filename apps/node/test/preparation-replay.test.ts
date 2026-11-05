import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
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
