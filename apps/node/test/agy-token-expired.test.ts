import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/providers/antigravity-terminal.js';
import { FAILURE } from '../src/terminal/failures.js';
import { TerminalHost } from '../src/terminal/host.js';
import { TurnWords } from '../src/terminal/program-restart.js';
import { Tmux } from '../src/terminal/tmux.js';

/* What Antigravity CLI says when its access token ran out in a program that has run for over an hour. */
const REJECTED =
  'generating and executing: UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.';

const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-agy-token-')));
  folders.push(home);
  const logs: string[] = [];
  const events: AgentEvent[] = [];
  const tmux = new Tmux({ env: { HOME: home }, recordingsDir: join(home, 'recordings') });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: m => logs.push(m) });
  const agent = host['agent']('token');
  Object.assign(agent, { home, workDir: home, contextDir: home, sessionId: 'session', program: agyProgram, hash: 'launch-hash' });
  /* Another turn of the same program, as the server's retry sends it. */
  const turn = (id: string) => {
    agent.ends.begin();
    agent.turn = { jobId: id, typed: false, seq: 0, words: new TurnWords(), onEvent: event => events.push(event) };
    agent.busy = agent.took = true;
    agent.ends.started(id);
  };
  turn('first');
  return { host, agent, tmux, logs, turn, home };
}

const stop = (c: ReturnType<typeof fixture>, reason = REJECTED) => c.host['hook']('token', 'stop', { error: reason, agy_error: { short_error: reason } });

describe('Antigravity refuses an expired sign-in token', () => {
  it('reads the 401 of a long-running program as a failure to try again, with its own words kept', () => {
    expect(FAILURE.antigravity({ short_error: REJECTED })).toMatchObject({ kind: 'unknown', retryable: true });
    expect(FAILURE.antigravity({ short_error: REJECTED }).text).toContain(REJECTED);
  });

  it.each([
    'UNAUTHENTICATED (code 401)',
    'Request had invalid authentication credentials.',
    'Expected OAuth 2 access token, login cookie or other valid authentication credential.',
  ])('knows the refusal by %s alone', short_error => {
    expect(FAILURE.antigravity({ short_error })).toMatchObject({ kind: 'unknown', retryable: true });
  });

  it('turns a second refusal, right after the program started anew, into a sign-in failure for Operations', () => {
    const second = FAILURE.antigravity({ short_error: REJECTED, retryable: true }, true);
    expect(second).toMatchObject({ kind: 'auth', retryable: false });
    expect(second.text).toMatch(/again/);
    expect(second.text).toMatch(/saved sign-in/);
    expect(second.text).toMatch(/owner signs in/);
    expect(second.text).toContain(REJECTED);
  });

  it('leaves the other Antigravity failures as they were, renewed or not', () => {
    expect(FAILURE.antigravity({ short_error: 'Please sign in' }, true)).toMatchObject({ kind: 'auth', retryable: false });
    expect(FAILURE.antigravity({ short_error: 'The server is overloaded' }, true)).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(FAILURE.antigravity({ short_error: 'plan model not specified' })).toMatchObject({ kind: 'unknown', retryable: false });
  });
});

describe('the host after Antigravity refused its token', () => {
  it('fails the turn to be tried again and starts the program anew, in its session, for that try', async () => {
    const c = fixture();
    await stop(c);
    expect(c.agent.turn!.ending).toMatchObject({ status: 'failed', failure: { kind: 'unknown', retryable: true } });
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
    expect(c.agent.hash).toBeNull();
    expect(c.agent.sessionId).toBe('session');
    expect(c.logs.join('\n')).toMatch(/401 UNAUTHENTICATED/);
  });

  it('allows one try: a second refusal in the program that started anew is a sign-in failure', async () => {
    const c = fixture();
    await stop(c);
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
    c.agent.hash = 'launch-hash';
    c.turn('second');
    await stop(c);
    expect(c.agent.turn!.ending).toMatchObject({ status: 'failed', failure: { kind: 'auth', retryable: false } });
    expect(c.agent.hash).toBeNull();
    expect(c.logs.join('\n')).toMatch(/401 UNAUTHENTICATED again/);
  });

  it('gives a program that answered a turn its one try again: the next hour has its own', async () => {
    const c = fixture();
    await stop(c);
    c.turn('retry');
    c.host['endTurn'](c.agent, { status: 'done', message: 'Done.' });
    c.turn('later');
    await stop(c);
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
  });

  it('gives it again after the owner signed in: a failure that ended in a sign-in failure starts afresh', async () => {
    const c = fixture();
    await stop(c);
    c.turn('second');
    await stop(c);
    expect(c.agent.failure).toMatchObject({ kind: 'auth' });
    c.turn('after the sign-in');
    await stop(c);
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
  });

  it('does not count another failure of the program that started anew as a refusal', async () => {
    const c = fixture();
    await stop(c);
    c.turn('retry');
    await stop(c, 'The server is overloaded');
    expect(c.agent.failure).toMatchObject({ kind: 'overloaded' });
    c.turn('next');
    await stop(c);
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
  });

  it('counts one refusal once when the screen and the Stop hook both tell of it', async () => {
    const c = fixture();
    const recording = c.tmux['recordings'].create(c.agent.name, c.home);
    const output = `AGY_ERROR: ${JSON.stringify({ short_error: REJECTED, retryable: false })}\n`;
    writeFileSync(recording.file, output);
    const position = Buffer.alloc(24);
    position.writeDoubleBE(Buffer.byteLength(output), 8);
    position.writeDoubleBE(Buffer.byteLength(output), 16);
    mkdirSync(join(recording.position, '..'), { recursive: true });
    writeFileSync(recording.position, position);
    c.agent.agyCursor = { file: recording.file, offset: 0 };
    c.host['agyFailed'](c.agent);
    expect(c.agent.turn!.ending).toMatchObject({ status: 'failed', failure: { kind: 'unknown', retryable: true } });
    await c.host['hook']('token', 'stop', { error: REJECTED });
    expect(c.agent.failure).toMatchObject({ kind: 'unknown', retryable: true });
    expect(c.agent.hash).toBeNull();
  });

  it('leaves the programs that are not Antigravity alone', async () => {
    const c = fixture();
    c.agent.program = null;
    await stop(c);
    expect(c.agent.hash).toBe('launch-hash');
    expect(c.agent.failure).toMatchObject({ kind: 'unknown' });
  });
});
