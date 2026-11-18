import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agyTokens, anthropicTokens, openaiTokens, TurnTally } from '../src/turn-tokens.js';
import { jobDone } from '../src/runner.js';

/* We test how Hornhoof reads the tokens a program says a turn used, from recorded samples of what each program writes,
   not the programs themselves. A program that tells none gives no data, never a made-up count.

   claude-new.jsonl, codex-new.jsonl and agy-new.jsonl are the programs' own headless output. claude-transcript-usage.jsonl
   keeps the shape of a Claude Code 2.1 session log as it lies on disk, with the words taken out: each content block of a
   message is a line of its own that repeats the message's usage. codex-rollout-usage.jsonl is a Codex session log written
   from the token counts Codex's turn.completed reports and the token_count events its rollout carries. */

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

describe("a program's report of a turn's tokens", () => {
  it("reads Claude Code's, whose input leaves out what came from the cache", () => {
    const result = fixture('claude-new.jsonl').find(line => line.type === 'result')!;
    expect(anthropicTokens(result.usage)).toEqual({ input: 2, output: 4, cacheRead: null, cacheWrite: null, total: 6 });
    expect(anthropicTokens({ input_tokens: 2, cache_creation_input_tokens: 16889, cache_read_input_tokens: 26992, output_tokens: 328 })).toEqual({ input: 2, output: 328, cacheRead: 26992, cacheWrite: 16889, total: 44211 });
  });

  it("reads Codex's, whose input counts the cached part too", () => {
    const completed = fixture('codex-new.jsonl').find(line => line.type === 'turn.completed')!;
    expect(openaiTokens(completed.usage)).toEqual({ input: 3316, output: 5, cacheRead: 12288, cacheWrite: 0, total: 15609 });
  });

  it("reads Antigravity's, whose input counts what it read from the cache and whose total it tells itself", () => {
    const result = fixture('agy-new.jsonl').find(line => line.event === 'result')!.result as Record<string, unknown>;
    expect(agyTokens(result.usage)).toEqual({ input: 2305, output: 589, cacheRead: 8113, cacheWrite: null, total: 11007 });
  });

  it('gives no data for a report without counts, and never a negative or broken one', () => {
    for (const read of [anthropicTokens, openaiTokens, agyTokens]) {
      expect(read(undefined)).toBeNull();
      expect(read({})).toBeNull();
      expect(read({ input_tokens: -5, output_tokens: 'many' })).toBeNull();
    }
    expect(openaiTokens({ input_tokens: 10, cached_input_tokens: 40, output_tokens: 2 })).toEqual({ input: 0, output: 2, cacheRead: 40, cacheWrite: null, total: 12 });
  });

  it('goes to Hornhoof with the end of the turn, and no data when the program told none', () => {
    const tokens = { input: 2, output: 4, cacheRead: null, cacheWrite: null, total: 6 };
    const ended = { ok: true, sessionId: 's', result: 'ready', output: '', error: null, limits: null };
    expect(jobDone('job-1', { ...ended, tokens }, [])).toMatchObject({ type: 'job.done', tokens });
    expect(jobDone('job-1', ended, [])).toMatchObject({ type: 'job.done', tokens: null });
  });
});

describe("the tokens of a turn in a live terminal", () => {
  it("adds up Claude Code's messages in the turn, each once though its log repeats it for every block", () => {
    const lines = fixture('claude-transcript-usage.jsonl');
    const tally = new TurnTally();
    /* What the log held from before belongs to no turn. */
    for (const line of lines.slice(0, 2)) tally.claudeLine(line);
    tally.begin();
    for (const line of lines.slice(2)) tally.claudeLine(line);
    expect(tally.tokens()).toEqual({ input: 4, output: 506, cacheRead: 70873, cacheWrite: 17299, total: 88682, model: 'claude-opus-5-5' });
    tally.begin();
    expect(tally.tokens()).toBeNull();
  });

  it("adds up what each of Codex's calls in the turn used, counting a repeated report once", () => {
    const tally = new TurnTally();
    /* A log read from its start, as when Hornhoof finds it in the middle of a turn: only the program's last turn counts. */
    for (const line of fixture('codex-rollout-usage.jsonl')) tally.codexLine(line);
    expect(tally.tokens()).toEqual({ input: 4500, output: 160, cacheRead: 33000, cacheWrite: null, total: 37660 });
  });

  /* Codex runs on its Default when Hornhoof names no model: the model its turn context names is the one the turn ran on. */
  it('takes the model a Codex turn ran on from its turn context', () => {
    const tally = new TurnTally();
    tally.begin();
    tally.codexLine({ type: 'turn_context', payload: { cwd: '/work', model: 'gpt-6.1-sol' } });
    for (const line of fixture('codex-rollout-usage.jsonl')) tally.codexLine(line);
    expect(tally.tokens()).toMatchObject({ total: 37660, model: 'gpt-6.1-sol' });
    tally.begin();
    tally.codexLine({ type: 'turn_context', payload: { cwd: '/work', model: '' } });
    expect(tally.tokens()).toBeNull();
  });

  it('gives no data for a turn whose program told no tokens', () => {
    const tally = new TurnTally();
    tally.begin();
    tally.codexLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: '3' } });
    tally.codexLine({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } });
    tally.claudeLine({ type: 'user', message: { role: 'user', content: 'Hello.' } });
    expect(tally.tokens()).toBeNull();
  });
});
