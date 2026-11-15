import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeMessage } from '@hornhoof/protocol';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

/* A plan's turn runs in its program's live terminal: its end tells Hornhoof what the turn used, from the lines of the
   program's own log the turn wrote, the recorded samples of turn-tokens.test.ts. A program whose log tells none ends with
   no data. */

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8').trim().split('\n').map(line => JSON.parse(line) as object);
const ended = (sent: NodeMessage[]) => sent.filter((m): m is Extract<NodeMessage, { type: 'job.done' }> => m.type === 'job.done');

describe("the tokens of a turn in a live terminal", () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

  it("go with the end of a Claude Code turn, each message once", async () => {
    const c = await liveTerminal('claude');
    for (const line of fixture('claude-transcript-usage.jsonl').slice(3)) c.record(line);
    c.finish('The tests pass.');
    const result = await c.on(c.running);
    expect(result).toMatchObject({ ok: true, tokens: { input: 4, output: 506, cacheRead: 70873, cacheWrite: 17299, total: 88682 } });
    expect(ended(c.sent).at(-1)).toMatchObject({ tokens: { total: 88682 } });
  });

  it("go with the end of a Codex turn, from its own calls alone", async () => {
    const c = await liveTerminal('codex');
    for (const line of fixture('codex-rollout-usage.jsonl').filter(line => (line as { payload?: { type?: string } }).payload?.type === 'token_count')) c.record(line);
    c.finish('The tests pass.');
    const result = await c.on(c.running);
    expect(result).toMatchObject({ ok: true, tokens: { input: 3316 + 4500, output: 165, cacheRead: 45288, cacheWrite: null, total: 15609 + 37660 } });
  });

  it('are no data for a turn whose log told none', async () => {
    const c = await liveTerminal('kimi');
    c.finish('Done.');
    expect((await c.on(c.running)).tokens ?? null).toBeNull();
  });
});
