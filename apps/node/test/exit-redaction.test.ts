import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServerMessage, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers/index.js';
import { runJob, type ProviderAdapter } from '../src/runner.js';

const CLI = String.raw`
const lines = Array.from({ length: 49 }, (_, i) => 'ordinary-' + i);
process.stderr.write(process.env.FAKE_ERROR_SECRET + '\n' + lines.join('\n') + '\n', () => process.exit(3));
`;

const cases = (['claude', 'codex', 'kimi'] as const).map(provider => ({ provider, mode: 'process' as const }));

describe('redaction before the program output line boundary', () => {
  let dir: string;
  let bin: string;
  let secret: string;
  let suffix: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hh-exit-boundary-'));
    bin = join(dir, 'cli.cjs');
    mkdirSync(join(dir, 'home'));
    writeFileSync(bin, '#!' + process.execPath + '\n' + CLI, { mode: 0o700 });
    suffix = randomBytes(24).toString('hex');
    secret = randomBytes(24).toString('hex') + '\n' + suffix;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check(done: Extract<NodeMessage, { type: 'job.done' }>) {
    expect(done.error).toBe('agent_failed');
    expect('programOutput' in done).toBe(false);
    expect(done.exit).toEqual({ code: 3, signal: null });
    expect(done.tail.includes(suffix)).toBe(false);
    expect(done.tail.includes('[hidden]')).toBe(true);
    expect(done.tail.split('\n').filter(line => line.startsWith('ordinary-'))).toHaveLength(49);
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
  }

  it.each(cases)('$mode $provider hides the whole known secret before limiting the final job.done.tail', async ({ provider }) => {
    const base = adapterFor(provider, { home: join(dir, 'home'), tools: join(dir, 'tools'), bin });
    const adapter: ProviderAdapter = { ...base, run: input => base.run({ ...input, env: { ...input.env, FAKE_ERROR_SECRET: secret } }) };
    const msg: Extract<ServerMessage, { type: 'job.run' }> = {
      type: 'job.run', jobId: 'boundary', subscriptionId: 'test', provider, prompt: 'boundary',
      sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, secret, instructions: null, toolToken: null,
    };
    const accepted = parseServerMessage(JSON.stringify(msg));
    expect(accepted?.type === 'job.run' && accepted.secret === secret).toBe(true);
    check(await runJob(adapter, msg, dir, {}));
  });

});
