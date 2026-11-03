import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeProgram } from '../src/terminal/programs.js';
import { envFile, Tmux } from '../src/terminal/tmux.js';
import { hasTmux, until } from './terminal-host-helpers.js';

const KEYS = ['NODE_KEY', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIMI_MODEL_NAME', 'AGY_ADC_AUTH'];
let tmux: Tmux;
let dir: string;
afterEach(async () => {
  await tmux?.stopAll();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasTmux)('agent environment in a real terminal', () => {
  async function report(file?: string): Promise<Record<string, string>> {
    const target = join(dir, 'env.json');
    const script = join(dir, 'probe.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(${JSON.stringify(KEYS)}.filter(k => k in process.env).map(k => [k, process.env[k]])))); setInterval(() => {}, 1000);`);
    await tmux.launch('probe', { cwd: dir, command: [process.execPath, script, target], envFile: file, cols: 80, rows: 24 });
    await until(() => existsSync(target));
    return JSON.parse(readFileSync(target, 'utf8'));
  }

  function start(): void {
    dir = mkdtempSync(join(tmpdir(), 'hh-env-'));
    tmux = new Tmux({ socket: `hh-env-${process.pid}-${Math.random().toString(36).slice(2)}`, env: {
      PATH: process.env.PATH, HOME: dir, ...Object.fromEntries(KEYS.map(key => [key, 'machine-setting'])),
    }, recordingsDir: join(dir, 'recordings') });
  }

  it('does not inherit machine program settings even without an env file', async () => {
    start();
    expect(await report()).toEqual({});
  });

  it.each([null, 500_000])('passes only the Claude compact window Hornhoof chose: %s', async compactWindow => {
    start();
    const spec = claudeProgram.launch({ bin: 'claude', home: dir, workDir: dir, sessionId: null, model: null,
      compactWindow, instructionsFile: null, urls: { hookUrl: 'http://localhost/hook', attachUrl: 'http://localhost/attach', mcpUrl: 'http://localhost/mcp' } });
    expect(await report(envFile(dir, spec.env))).toEqual(compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } : {});
  });

  it.each([false, true])('removes stale settings from an existing tmux server, env file: %s', async withFile => {
    start();
    await tmux.launch('old', { cwd: dir, command: ['sleep', '30'], cols: 80, rows: 24 });
    for (const key of KEYS) await tmux.run(['set-environment', '-g', key, 'old-machine-setting']);
    expect(await report(withFile ? envFile(dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' }) : undefined))
      .toEqual(withFile ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' } : {});
  });
});
