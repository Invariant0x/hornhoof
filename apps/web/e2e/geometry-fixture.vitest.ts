import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { geometryServer } from './geometry-fixture';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

afterEach(() => vi.unstubAllEnvs());

for (const field of ['HH_GEOMETRY_SOURCE_ROOT', 'HH_GEOMETRY_SOURCE_SHA']) {
  it('refuses missing pinned input without a host fallback: ' + field, async () => {
    vi.stubEnv('HH_GEOMETRY_SOURCE_ROOT', source);
    vi.stubEnv('HH_GEOMETRY_SOURCE_SHA', sha);
    vi.stubEnv(field, undefined);
    await expect(geometryServer()).rejects.toThrow(/NOT_RUN: geometry requires a pinned source checkout.*no host fallback/);
  });
}

it('starts the actual fixture and makes repeated cleanup safe', async () => {
  vi.stubEnv('HH_GEOMETRY_SOURCE_ROOT', source);
  vi.stubEnv('HH_GEOMETRY_SOURCE_SHA', sha);
  const fixture = await geometryServer();
  onTestFinished(() => fixture.stop());
  expect(fixture.sourceSha).toBe(sha);
  const health = await fetch(fixture.origin + '/api/health');
  expect(health.status).toBe(200);
  expect((await health.json() as { ok: boolean }).ok).toBe(true);
  await fixture.stop();
  await fixture.stop();
  await expect(fetch(fixture.origin + '/api/health')).rejects.toThrow();
});
