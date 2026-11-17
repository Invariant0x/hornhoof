import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { installCheckCommand } from '../src/check-command-runner.js';

it.each(['darwin', 'linux'] as const)('keeps check invocation local on %s with the intended platform wrapper', platform => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-check-platform-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, 'recorded-cli.cjs');
  writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  installCheckCommand(dir, cli, platform);
  const bin = join(dir, 'tools', 'bin');
  expect(existsSync(join(bin, 'node'))).toBe(platform === 'linux');
  for (const name of ['tsc', 'vitest']) {
    const tool = join(dir, name);
    writeFileSync(tool, 'process.stdout.write("direct:" + process.argv[2])');
    const run = spawnSync('node', [tool, 'recorded'], { env: { PATH: `${bin}:${dirname(process.execPath)}`, HH_BRIDGE: 'http://example.test/hook/sample' }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe(platform === 'darwin' ? 'direct:recorded' : JSON.stringify(['--wait', '--', process.execPath, tool, 'recorded']));
  }
  expect(existsSync(join(bin, 'hh-check'))).toBe(true);
});
