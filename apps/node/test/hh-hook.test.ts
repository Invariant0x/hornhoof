import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const run = promisify(execFile);

describe('hh-hook', () => {
  it('tells a program that compacted its conversation to read the company again, without a bridge', () => {
    const out = execFileSync('node', [HOOK, 'compact', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(out).toContain('compacted');
    expect(out).toContain('instructions');
  });

  it('prints nothing for the events it only passes on', () => {
    expect(execFileSync('node', [HOOK, 'status', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })).toBe('');
  });

  /* The program adds what its prompt hook prints to the prompt; a status line shows what its command prints. */
  it("prints the bridge's answer to a prompt, and only to a prompt", async () => {
    const bridge = createServer((req, res) => req.resume().on('end', () => res.end(`said to ${req.url}`)));
    await new Promise<void>(r => bridge.listen(0, '127.0.0.1', r));
    const env = { PATH: process.env.PATH, HH_BRIDGE: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}` };
    try {
      expect((await run('node', [HOOK, 'prompt', '{"prompt":"hi"}'], { env })).stdout).toBe('said to /prompt\n');
      expect((await run('node', [HOOK, 'status', '{}'], { env })).stdout).toBe('');
      expect((await run('node', [HOOK, 'invocation', '{}'], { env })).stdout).toBe('');
    } finally {
      bridge.close();
    }
  });
});
