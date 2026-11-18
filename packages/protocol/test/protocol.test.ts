import { describe, expect, it } from 'vitest';
import { API_MODELS, CLAUDE_ALIASES, CRED_KINDS, cut, defaultEffortOf, lastBytes, MAX_OPEN_TASKS, MAX_RUN_FILES, MAX_TEST_PARTS, TAIL_BYTES, TEST_LOG_BYTES, COMPANY_TEMPLATES, COMPANY_TEMPLATE_KEYS, DEPARTMENT_TEMPLATES, TEMPLATE_KEYS, effortFor, effortsOf, modelsFor, parseNodeMessage, parseServerMessage, PROGRAM_SCREEN_MAX, PROGRAM_STATES, repoFolder, type AgentEvent, type NodeMessage, type ServerMessage } from '../src/index.js';
import { effortsOf as light, effortFor as lightEffort } from '../src/efforts.js';
import * as protocol from '../src/index.js';

const LIMITS = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.38, resetsAt: '2026-10-29T21:30:00.000Z' }] };

it('shares the 15 second receipt wait for unconfirmed words after a turn ends', () => {
  expect(protocol.UNHEARD_MS).toBe(15_000);
});

const NODE: NodeMessage[] = [
  { type: 'hello', version: '0.2.0', loggedIn: true, running: ['job-1'] },
  { type: 'status', loggedIn: false, limits: LIMITS },
  { type: 'status', loggedIn: true, limits: null },
  { type: 'hello', version: '0.4.0', loggedIn: true, running: [], models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  { type: 'status', loggedIn: true, limits: null, models: [] },
  /* Signed in, but its program waits for a first setup only the plan's owner may pass. */
  { type: 'status', loggedIn: true, setupNeeded: true, limits: null },
  { type: 'hello', version: '0.5.2', loggedIn: true, setupNeeded: true, running: [] },
  { type: 'job.started', jobId: 'job-1' },
  { type: 'job.done', jobId: 'job-1', ok: true, sessionId: 'abc', result: 'ready', tail: '', error: null },
  { type: 'job.done', jobId: 'job-2', ok: false, sessionId: null, result: '', tail: 'boom', error: 'timeout' },
  { type: 'job.done', jobId: 'job-3', ok: false, sessionId: 'abc', result: '', tail: 'boom', error: 'agent_failed', exit: { code: 1, signal: null } },
  { type: 'job.done', jobId: 'job-4', ok: false, sessionId: null, result: '', tail: '', error: 'agent_failed', exit: { code: null, signal: 'SIGTERM' } },
  { type: 'removed' },
  { type: 'job.event', jobId: 'job-1', seq: 0, event: { kind: 'text', text: 'Hello' } },
  { type: 'job.event', jobId: 'job-1', seq: 1, event: { kind: 'tool', name: 'propose_structure', input: '{"brief":"Shoes"}' } },
  { type: 'job.event', jobId: 'job-1', seq: 2, event: { kind: 'tool_result', ok: true, summary: 'Proposal p1 shown' } },
  { type: 'job.event', jobId: 'job-1', seq: 3, event: { kind: 'todo', items: [{ text: 'Ask about products', state: 'done' }, { text: 'Propose', state: 'doing' }] } },
];

const SERVER: ServerMessage[] = [
  { type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'Reply with one word: ready', sessionId: null, model: null, timeoutMs: 120000, secret: null, instructions: null, toolToken: null },
  { type: 'job.run', jobId: 'job-2', subscriptionId: 's2', provider: 'openai_api', prompt: 'hi', sessionId: 'thread', model: 'gpt-5', timeoutMs: 1000, secret: 'sk-test', instructions: 'You are the orchestrator.', toolToken: 'tok' },
  { type: 'job.cancel', jobId: 'job-1' },
  { type: 'job.ack', jobId: 'job-1' },
  { type: 'remove' },
];

describe('node messages', () => {
  it('carries settled words for their original agent and job', () => {
    const message = { type: 'agent.words_settled', agentKey: 'agent-1', jobId: 'job-1' };
    expect(parseNodeMessage(JSON.stringify(message))).toEqual(message);
    expect(parseNodeMessage(JSON.stringify({ ...message, jobId: null }))).toBeNull();
  });
  it('carries waiting words on a job end and still accepts older nodes', () => {
    const done = { type: 'job.done', jobId: 'job-1', ok: true, sessionId: null, result: '', tail: '', error: null };
    for (const message of [done, { ...done, wordsWaiting: true }, { ...done, wordsWaiting: false }]) {
      expect(parseNodeMessage(JSON.stringify(message))).toEqual(message);
    }
    expect(parseNodeMessage(JSON.stringify({ ...done, wordsWaiting: 'yes' }))).toBeNull();
  });

  it('keeps the original job of a turn the program starts from queued live words', () => {
    const message = { type: 'turn.open', agentKey: 'agent-1', text: 'Queued words.', queuedFrom: 'job-1', ref: 'next' };
    expect(parseNodeMessage(JSON.stringify(message))).toEqual(message);
  });
  it.each(['job-1', null])('carries unheard words with job %s and bounds their text like agent.say', jobId => {
    const message = { type: 'agent.unheard', agentKey: 'agent-1', jobId, text: 'From Hornhoof:\n\nKeep these words.' };
    expect(parseNodeMessage(JSON.stringify(message))).toEqual(message);
    expect(parseNodeMessage(JSON.stringify({ ...message, text: 'x'.repeat(100_000) }))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...message, text: 'x'.repeat(100_001) }))).toBeNull();
  });

  it('round-trip through JSON', () => {
    for (const m of NODE) expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for broken JSON, an unknown type or a missing field', () => {
    expect(parseNodeMessage('{nope')).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hack' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.done', jobId: 'x', ok: true }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: { status: 'fine', windows: [] } }))).toBeNull();
  });

  it("refuse a job's end whose program exit is not a whole code and a signal's name", () => {
    const done = { type: 'job.done', jobId: 'x', ok: false, sessionId: null, result: '', tail: '', error: 'agent_failed' };
    expect(parseNodeMessage(JSON.stringify({ ...done, exit: { code: 1.5, signal: null } }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...done, exit: { code: null, signal: 'S'.repeat(41) } }))).toBeNull();
  });
});

describe('turn failures', () => {
  const done: NodeMessage = { type: 'job.done', jobId: 'job-1', ok: false, sessionId: 'abc', result: '', tail: '', error: 'agent_failed' };

  it.each(['overloaded', 'rate_limited', 'usage_limit', 'auth', 'setup', 'network', 'cut', 'refused', 'too_big', 'crash', 'unknown'])('carry a failed turn whose program reports %s', kind => {
    const m = { ...done, failure: { kind, text: 'The program said why it failed.', retryable: true } };
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });

  it('still take the end of a turn from a node before failure kinds', () => {
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
  });

  it('refuse a failure with an unknown kind', () => {
    expect(parseNodeMessage(JSON.stringify({ ...done, failure: { kind: 'busy', text: 'Busy now.', retryable: true } }))).toBeNull();
  });

  it("keep at most 2000 characters of the program's own words for a failure", () => {
    const m = { ...done, failure: { kind: 'unknown', text: 'x'.repeat(2000), retryable: false } };
    expect(parseNodeMessage(JSON.stringify({ ...m, failure: { ...m.failure, text: 'x'.repeat(2001) } }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });
});

describe('server messages', () => {
  it('round-trip through JSON', () => {
    for (const m of SERVER) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for a job without a timeout or an unknown provider', () => {
    const noTimeout = { ...SERVER[0], timeoutMs: undefined };
    expect(parseServerMessage(JSON.stringify(noTimeout))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], provider: 'gemini' }))).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
  });

  it("take a job for a Google plan, which Antigravity CLI runs", () => {
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], provider: 'antigravity' }))).toMatchObject({ type: 'job.run', provider: 'antigravity' });
  });

  it('give null for a timeout longer than a timer can wait, which would end the job at once', () => {
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], timeoutMs: 2 ** 31 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], timeoutMs: 2 ** 31 - 1 }))).not.toBeNull();
  });

  it('give null for ids that could leave the node folder, since the node puts them in paths', () => {
    for (const id of ['../../etc', 'a/b', '', 'x'.repeat(65)]) {
      expect(parseServerMessage(JSON.stringify({ ...SERVER[0], jobId: id }))).toBeNull();
      expect(parseServerMessage(JSON.stringify({ ...SERVER[0], subscriptionId: id }))).toBeNull();
    }
  });

  it("carry an agent's skills as files to write, each named so it stays a folder of the skills folder", () => {
    const skills = [{ name: 'dev-tdd', description: 'Test-driven development: writes the failing test first.', body: 'x'.repeat(50_000) }];
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], skills }))).toMatchObject({ type: 'job.run', skills });
    for (const name of ['../etc', 'a/b', '.hidden', 'Dev-Tdd', '', 'x'.repeat(65)]) {
      expect(parseServerMessage(JSON.stringify({ ...SERVER[0], skills: [{ ...skills[0], name }] })), name).toBeNull();
    }
  });

  it('carries the full instructions and skill files', () => {
    const instructions = 'Full assignment.\n'.repeat(20_000);
    const skills = Array.from({ length: 210 }, (_, i) => ({ name: `skill-${i}`, description: 'Example skill', body: i ? 'A skill.' : instructions }));
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], instructions, skills }))).toMatchObject({ type: 'job.run', instructions, skills });
  });

  it('allows an untimed one-shot call and still requires a time for other jobs', () => {
    const job = { ...SERVER[0], timeoutMs: 0 };
    expect(parseServerMessage(JSON.stringify(job))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...job, call: true }))).toMatchObject({ call: true, timeoutMs: 0 });
  });

  it('take the hello of a node that still says it writes skills as files, and leave that word out: every node writes them', () => {
    const hello = { type: 'hello', version: '0.5.0', loggedIn: true, running: [] };
    expect(parseNodeMessage(JSON.stringify({ ...hello, skillFiles: true }))).toEqual(hello);
  });
});

describe('live agent events', () => {
  const event = (e: unknown) => parseNodeMessage(JSON.stringify({ type: 'job.event', jobId: 'job-1', seq: 0, event: e }));

  it('refuse a tool input longer than 300 characters', () => {
    expect(event({ kind: 'tool', name: 'Bash', input: 'x'.repeat(300) })).not.toBeNull();
    expect(event({ kind: 'tool', name: 'Bash', input: 'x'.repeat(301) })).toBeNull();
  });

  it('refuse an unknown kind, a negative seq and an unknown todo state', () => {
    expect(event({ kind: 'thinking', text: 'hm' })).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.event', jobId: 'job-1', seq: -1, event: { kind: 'text', text: 'a' } }))).toBeNull();
    expect(event({ kind: 'todo', items: [{ text: 'a', state: 'later' }] })).toBeNull();
  });

  it('keep at most 20 plan items', () => {
    const items = (n: number): AgentEvent => ({ kind: 'todo', items: Array.from({ length: n }, (_, i) => ({ text: `step ${i}`, state: 'todo' as const })) });
    expect(event(items(20))).not.toBeNull();
    expect(event(items(21))).toBeNull();
  });
});

describe('test runs', () => {
  const LOAD = { cpus: 8, load: 1.5, memFree: 4e9, memTotal: 16e9, tests: 0, jobs: 2 };
  const RUN = { type: 'tests.run', partId: 'p-1', repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_x' }, branch: 'task-12-checkout', task: 12, command: 'npm test', part: 1, parts: 2, timeoutMs: 1_800_000 };
  const parse = (m: object) => parseServerMessage(JSON.stringify(m));

  it('takes a quiet budget alone for tests and requires a wall limit for work', () => {
    const quiet = { ...RUN, timeoutMs: undefined, silenceMs: 60_000 };
    expect(parse(quiet)).toMatchObject({ silenceMs: 60_000 });
    expect(parse({ ...quiet, silenceMs: undefined })).toBeNull();
    expect(parse({ ...quiet, kind: 'work' })).toBeNull();
  });

  it("carry a node's load in its hello and on their own, with the parts it runs", () => {
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: LOAD, tests: ['p-1'] }))).toMatchObject({ load: LOAD, tests: ['p-1'] });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD }))).toEqual({ type: 'load', ...LOAD });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, cpus: 0 }))).toBeNull();
  });

  it("say whether the machine's kernel killed a process for want of memory since the node's report before, from newer nodes only", () => {
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, memoryShort: true }))).toEqual({ type: 'load', ...LOAD, memoryShort: true });
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: { ...LOAD, memoryShort: false } }))).toMatchObject({ load: { ...LOAD, memoryShort: false } });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, memoryShort: 'yes' }))).toBeNull();
    /* The count itself stays on the node. */
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, oomKills: 26 }))).toEqual({ type: 'load', ...LOAD });
  });

  it('name the agents whose programs run on a node that says so, and leave a list that is not one out instead of refusing the frame', () => {
    const live = ['7f1c2a9e-0b1d-4c55-9d1e-3f0a8b6c2d11', 'receipt'];
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.17.3', loggedIn: true, running: [], load: LOAD, live }))).toMatchObject({ live });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, live }))).toEqual({ type: 'load', ...LOAD, live });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, live: [] }))).toEqual({ type: 'load', ...LOAD, live: [] });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, live: ['a b'] }))).toEqual({ type: 'load', ...LOAD });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, live: Array.from({ length: 201 }, (_, i) => `a${i}`) }))).toEqual({ type: 'load', ...LOAD });
  });

  it("carry what the node can use of its machine's processor and disk, and what the machine has, from newer nodes only", () => {
    const MACHINE = { cpuModel: 'Apple M2 Pro', diskFree: 120e9, diskTotal: 460e9, host: 'host-a', hostCpus: 10, hostLoad: 2.5, hostMemFree: 20e9, hostMemory: 32e9 };
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, ...MACHINE }))).toEqual({ type: 'load', ...LOAD, ...MACHINE });
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, cpuModel: 'x'.repeat(201) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, host: '' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, host: 'x'.repeat(201) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, hostCpus: 0 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, hostLoad: -1 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'load', ...LOAD, hostMemFree: -1 }))).toBeNull();
  });

  it('send a part with an https repository, a plain branch or none, and at most the parts a run splits into', () => {
    expect(parse(RUN)).toEqual(RUN);
    expect(parse({ ...RUN, branch: null })).toMatchObject({ branch: null });
    for (const bad of [{ repo: { url: 'http://github.com/acme/shop.git', token: '' } }, { repo: { url: 'https://me:pw@github.com/acme/shop.git', token: '' } }, { branch: '--upload-pack=x' }, { branch: 'a..b' }, { parts: MAX_TEST_PARTS + 1 }, { part: 0 }, { partId: '../x' }, { command: '' }]) {
      expect(parse({ ...RUN, ...bad })).toBeNull();
    }
    expect(parse({ type: 'tests.cancel', partId: 'p-1' })).toEqual({ type: 'tests.cancel', partId: 'p-1' });
    expect(parse({ type: 'tests.ack', partId: 'p-1' })).toEqual({ type: 'tests.ack', partId: 'p-1' });
  });

  it("end a part with how it went and its log, at most a megabyte of it", () => {
    const done = { type: 'tests.done', partId: 'p-1', ok: false, exitCode: 1, error: 'failed', commit: 'a'.repeat(40), log: 'x'.repeat(TEST_LOG_BYTES) };
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
    expect(parseNodeMessage(JSON.stringify({ ...done, log: 'x'.repeat(TEST_LOG_BYTES + 2000) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...done, error: 'exploded' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'tests.started', partId: 'p-1' }))).toEqual({ type: 'tests.started', partId: 'p-1' });
    expect(parseNodeMessage(JSON.stringify({ ...done, error: 'files_failed' }))).toMatchObject({ error: 'files_failed' });
  });

  it('send a part of other work, with a repository or none, and the plain names of the task files it takes', () => {
    const work = { ...RUN, kind: 'work', repo: null, branch: null, files: ['data.csv', 'photo 1.png'] };
    expect(parse(work)).toEqual(work);
    expect(parse({ ...work, repo: RUN.repo, branch: 'main' })).toMatchObject({ kind: 'work', branch: 'main' });
    for (const bad of [{ kind: 'mining' }, { files: ['../keys'] }, { files: ['a/b.txt'] }, { files: ['..'] }, { files: [''] }, { files: Array.from({ length: MAX_RUN_FILES + 1 }, (_, i) => `f${i}`) }]) {
      expect(parse({ ...work, ...bad })).toBeNull();
    }
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], work: true }))).toMatchObject({ work: true });
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], work: false, noRuns: 'No user of its own.' }))).toMatchObject({ noRuns: 'No user of its own.' });
  });
});

describe('calling a job off', () => {
  it('refuses an id with a slash', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'job.cancel', jobId: 'a/b' }))).toBeNull();
  });
});

describe('which turns a node still runs', () => {
  it('asks of up to 100 named turns and takes the answer of what was asked and what is held', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'jobs.check', jobIds: ['job-1', 'job-2'] }))).toEqual({ type: 'jobs.check', jobIds: ['job-1', 'job-2'] });
    expect(parseServerMessage(JSON.stringify({ type: 'jobs.check', jobIds: [] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'jobs.check', jobIds: Array.from({ length: 101 }, (_, i) => `job-${i}`) }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'jobs.check', jobIds: ['a/b'] }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'jobs.held', asked: ['job-1', 'job-2'], held: ['job-2'] }))).toEqual({ type: 'jobs.held', asked: ['job-1', 'job-2'], held: ['job-2'] });
    expect(parseNodeMessage(JSON.stringify({ type: 'jobs.held', asked: ['job-1'] }))).toBeNull();
  });
});

describe('job.run', () => {
  it('carries the effort the agent thinks at, only as a plain level name', () => {
    const run = { ...(SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>), effort: 'max' };
    expect(parseServerMessage(JSON.stringify(run))).toEqual(run);
    expect(parseServerMessage(JSON.stringify({ ...run, effort: null }))).toEqual({ ...run, effort: null });
    expect(parseServerMessage(JSON.stringify({ ...run, effort: '--dangerously' }))).toBeNull();
  });

  it("may carry an assistant's whole conversation, as words of any length", () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const freshPrompt = 'Max: hi\n\nMiu: hello\n'.repeat(20_000);
    expect(parseServerMessage(JSON.stringify({ ...run, freshPrompt }))).toEqual({ ...run, freshPrompt });
    expect(parseServerMessage(JSON.stringify(run))).toEqual(run);
    expect(parseServerMessage(JSON.stringify({ ...run, freshPrompt: 7 }))).toBeNull();
  });

  it('needs instructions and a tool token, even when they are null', () => {
    const noInstructions = { ...SERVER[0], instructions: undefined };
    const noToken = { ...SERVER[0], toolToken: undefined };
    expect(parseServerMessage(JSON.stringify(noInstructions))).toBeNull();
    expect(parseServerMessage(JSON.stringify(noToken))).toBeNull();
  });

  it('may carry the workspace an agent works in, with its repository', () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const repo = { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_x' };
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo } }))).toMatchObject({ workspace: { key: 'a1', repo } });
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: null } }))).toMatchObject({ workspace: { key: 'a1', repo: null } });
    expect(parseServerMessage(JSON.stringify(run))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: '../x', repo: null } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, url: 'http://github.com/acme/app.git' } } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, branch: '--upload-pack=x' } } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, url: 'https://x:ghp_y@github.com/acme/app.git' } } }))).toBeNull();
    for (const url of ['https://[', 'https://', 'https://exa mple.com/x', 'https://github.com:99999/acme/app.git']) expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, url } } }))).toBeNull();
  });

  it("may name the repository in the company's registry of what is built, so its dependencies come from a build of it", () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const repo = { url: 'https://github.com/acme/app.git', branch: 'main', token: '' };
    const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'a'.repeat(64) };
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, repositoryScope } }))).toMatchObject({ workspace: { key: 'a1', repo, repositoryScope } });
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, repositoryScope: { ...repositoryScope, repoUrlHash: 'not a digest' } } }))).toBeNull();
  });

  it("may say which of the company's tasks are still open, so the node takes away the worktrees of closed ones", () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const repo = { url: 'https://github.com/acme/app.git', branch: 'main', token: '' };
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, tasks: { open: [4, 9], upTo: 12 } } }))).toMatchObject({ workspace: { tasks: { open: [4, 9], upTo: 12 } } });
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, tasks: { open: [0], upTo: 12 } } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, tasks: { open: [], upTo: -1 } } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo, tasks: { open: Array.from({ length: MAX_OPEN_TASKS + 1 }, (_, i) => i + 1), upTo: MAX_OPEN_TASKS + 1 } } }))).toBeNull();
  });

  it("may name the author of the agents' commits, as one plain line and an address", () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const repo = { url: 'https://github.com/acme/app.git', branch: 'main', token: '' };
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };
    const withAuthor = (a: unknown) => parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, author: a } } }));
    expect(withAuthor(author)).toMatchObject({ workspace: { repo: { author } } });
    expect(withAuthor(null)).toMatchObject({ workspace: { repo: { author: null } } });
    expect(withAuthor({ ...author, name: 'Alex\n[core]' })).toBeNull();
    expect(withAuthor({ ...author, name: '' })).toBeNull();
    expect(withAuthor({ ...author, email: 'not an address' })).toBeNull();
  });

  it('names the folder a repository is cloned into after the last part of its address', () => {
    expect(repoFolder('https://github.com/acme/app.git')).toBe('app');
    expect(repoFolder('https://github.com/acme/My App/')).toBe('My-App');
    expect(repoFolder('https://gitlab.com/acme/.hidden.git')).toBe('hidden');
    expect(repoFolder('https://github.com/acme/..')).toBe('repo');
  });
});

describe('department templates', () => {
  it('are the ten starting departments, with operations always on', () => {
    expect(DEPARTMENT_TEMPLATES.map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance', 'home_devices', 'household']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.always).map(t => t.key)).toEqual(['operations']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.ticked).map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development']);
  });
});

describe('company templates', () => {
  it('are nine, each with a distinct key from the list', () => {
    expect(COMPANY_TEMPLATES.map(t => t.key)).toEqual([...COMPANY_TEMPLATE_KEYS]);
    expect(new Set(COMPANY_TEMPLATES.map(t => t.key)).size).toBe(9);
  });

  it('build only from departments that exist, with sound nesting and staffing', () => {
    for (const template of COMPANY_TEMPLATES) {
      expect(template.departments.length, template.key).toBeGreaterThan(0);
      const unnamed = new Set<string>();
      let operations = 0;
      for (const dept of template.departments) {
        expect(TEMPLATE_KEYS, `${template.key}: ${dept.template}`).toContain(dept.template);
        if (dept.template === 'operations') operations += 1;
        /* A template used a second time in one company needs its own name, as the structure card requires. */
        if (!dept.name) {
          expect(unnamed.has(dept.template), `${template.key}: ${dept.template} twice without a name`).toBe(false);
          unnamed.add(dept.template);
        }
        for (const product of dept.products ?? []) expect(product.trim().length, `${template.key} product`).toBeGreaterThan(0);
        expect((dept.products ?? []).length, `${template.key} products`).toBeLessThanOrEqual(10);
        expect(dept.staff.length, `${template.key}: ${dept.template} staff`).toBeGreaterThan(0);
        for (const line of dept.staff) {
          expect(line.role, `${template.key}: ${dept.template}`).toMatch(/^[A-Z]{3}-[A-Z0-9]+$/);
          expect(line.count, `${template.key}: ${line.role}`).toBeGreaterThanOrEqual(1);
          expect(line.count, `${template.key}: ${line.role}`).toBeLessThanOrEqual(30);
        }
      }
      expect(operations, `${template.key} operations`).toBeLessThanOrEqual(1);
    }
  });

  it('give every company its own Operations, which keeps it running', () => {
    for (const template of COMPANY_TEMPLATES) {
      const operations = template.departments.find(d => d.template === 'operations');
      expect(operations, `${template.key} has operations`).toBeDefined();
      expect(operations!.staff.some(line => line.role === 'OPS-HEAD'), `${template.key} operations head`).toBe(true);
    }
  });

  it('staff Operations in full in all nine, one of each required role, and keep their other roles', () => {
    const required = ['OPS-BUGS', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH'];
    const others: Record<string, string[]> = { project: [], startup: [], studio: ['OPS-INTEG'], corporation: ['OPS-FIX', 'OPS-INTEG'], security: ['OPS-INTEG'], opensource: [], agency: ['OPS-FIX', 'OPS-INTEG'], lab: [], home: [] };
    expect(Object.keys(others).sort()).toEqual([...COMPANY_TEMPLATE_KEYS].sort());
    for (const template of COMPANY_TEMPLATES) {
      const { staff } = template.departments.find(d => d.template === 'operations')!;
      /* The product manager every department of a template hires is in Operations too, though Hornhoof does not require it. */
      expect(staff.map(line => line.role).sort(), template.key).toEqual([...required, 'OPS-PM', ...others[template.key]!].sort());
      expect(staff.every(line => line.count === 1), template.key).toBe(true);
    }
  });
});

describe('lastBytes', () => {
  it("keeps a short text and the end of a long one, counted in UTF-8 bytes like a job's tail", () => {
    expect(lastBytes('short')).toBe('short');
    expect(Buffer.byteLength(lastBytes('x'.repeat(TAIL_BYTES + 10)))).toBe(TAIL_BYTES);
    expect(lastBytes('abcdef', 3)).toBe('def');
    expect(lastBytes('aaaaé', 2)).toBe('é');
  });
});

describe('cut', () => {
  it('keeps short text and ends cut text with an ellipsis', () => {
    expect(cut('abcdef', 4)).toBe('abc…');
    expect(cut('abc', 4)).toBe('abc');
    expect(cut('abcd', 4)).toBe('abcd');
  });
});

describe('models', () => {
  it('accepts hello with models and without, up to 60 of them', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.4.0', loggedIn: true, running: [], models: many }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.4.0', loggedIn: true, running: [], models: [{ id: 'x'.repeat(81), name: 'X' }] }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] }))).toEqual({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  });

  it('lists models for each provider', () => {
    expect(API_MODELS.anthropic_api.map(m => m.id)).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(API_MODELS.openai_api.map(m => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']);
    expect(CLAUDE_ALIASES.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    const reported = [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }];
    expect(modelsFor('codex', reported)).toEqual(reported);
    expect(modelsFor('anthropic_api', null)).toEqual(API_MODELS.anthropic_api);
    expect(modelsFor('claude', null)).toEqual(CLAUDE_ALIASES);
    expect(modelsFor('kimi', null)).toEqual([]);
    expect(modelsFor('codex', [])).toEqual([]);
  });

  it('carry how hard each model can think, and the level it thinks at by default', () => {
    const kimi = { id: 'kimi-code/k3.1-pro', name: 'K3.1 Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: null, models: [kimi] }))).toEqual({ type: 'status', loggedIn: true, limits: null, models: [kimi] });
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: null, models: [{ ...kimi, efforts: ['max; rm -rf'] }] }))).toBeNull();
    for (const m of [...CLAUDE_ALIASES, ...API_MODELS.anthropic_api]) expect(m.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const m of API_MODELS.openai_api) expect(m.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it("knows the level each model runs at when nobody picked one, as its program's docs give it", () => {
    /* Claude Code: high, but medium on the 5.5 models, and its Default model is Opus 5.5. A node's older list has no defaults. */
    const old = CLAUDE_ALIASES.map(model => {
      const legacy = { ...model };
      delete legacy.defaultEffort;
      return legacy;
    });
    expect(['fable', 'opus', 'sonnet', 'haiku', ''].map(m => defaultEffortOf('claude', old, m))).toEqual(['high', 'medium', 'medium', 'medium', 'medium']);
    expect(['claude-fable-5-1', 'claude-opus-5-5', ''].map(m => defaultEffortOf('anthropic_api', API_MODELS.anthropic_api, m))).toEqual(['high', 'medium', 'medium']);
    /* Codex says it per model; its Default model and GLM's say nothing. */
    expect(defaultEffortOf('codex', [{ id: 'gpt-6.1-sol', name: 'Sol', defaultEffort: 'low' }], 'gpt-6.1-sol')).toBe('low');
    expect(defaultEffortOf('codex', [{ id: 'gpt-6.1-sol', name: 'Sol', defaultEffort: 'low' }], '')).toBeNull();
    expect(defaultEffortOf('glm', [], '')).toBeNull();
    expect(defaultEffortOf('kimi', [{ id: 'k3', name: 'K3', efforts: ['low', 'high'] }], 'k3')).toBeNull();
    expect(modelsFor('claude', old).map(m => m.defaultEffort)).toEqual(['high', 'medium', 'medium', 'medium']);
  });

  it('leaves a model at its program default without a role effort', () => {
    expect(effortFor(null, ['low', 'high', 'max'])).toBeNull();
    expect(effortFor(null, [])).toBeNull();
  });

  it.each([
    ['xhigh', ['low', 'xhigh', 'max'], 'xhigh'],
    ['xhigh', ['low', 'high', 'max'], 'high'],
    ['medium', ['low', 'high', 'max'], 'low'],
    ['low', ['max', 'high'], 'high'],
    ['xhigh', ['ultra'], 'ultra'],
    ['max', ['ultra', 'low', 'xhigh', 'high'], 'xhigh'],
    ['xhigh', [], null],
  ])('fits the role effort %s to %j as %s', (role, levels, expected) => {
    expect(effortFor(null, levels, role)).toBe(expected);
  });

  it('keeps a supported pick or a pick whose model has no known levels', () => {
    expect(effortFor('max', ['low', 'high', 'max'], 'xhigh')).toBe('max');
    expect(effortFor('medium', ['low', 'medium'], 'low')).toBe('medium');
    expect(effortFor('xhigh', [], 'medium')).toBe('xhigh');
    expect(effortFor('xhigh', ['low', 'high', 'max'], 'medium')).toBe('low');
    expect(effortFor('ultra', ['low', 'medium'])).toBeNull();
  });

  it("displays Codex's own default without choosing its highest level", () => {
    const sol = { id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' };
    expect(defaultEffortOf('codex', [sol], sol.id)).toBe('medium');
    expect(defaultEffortOf('codex', [sol], '')).toBeNull();
  });

  it("lists a model's efforts, and for the Default model the levels every model that names some takes", () => {
    const models = [
      { id: 'a', name: 'A', efforts: ['low', 'high'] },
      { id: 'b', name: 'B', efforts: ['low', 'max'] },
      { id: 'c', name: 'C' },
    ];
    expect(effortsOf(models, 'b')).toEqual(['low', 'max']);
    expect(effortsOf(models, 'c')).toEqual([]);
    /* The program picks the Default model itself, so only a level every model takes is safe for it. */
    expect(effortsOf(models, '')).toEqual(['low']);
    expect(effortsOf(models, null)).toEqual(['low']);
    /* A model the subscription does not run runs on its Default. */
    expect(effortsOf(models, 'gone')).toEqual(['low']);
    expect(effortsOf([{ id: 'c', name: 'C' }], '')).toEqual([]);
  });

  it('takes an empty list of efforts as none known, and an unknown model as the Default', () => {
    /* No efforts known: a picked level goes through, and Default sends no flag. */
    expect(effortFor('high', [])).toBe('high');
    expect(effortFor(null, [])).toBeNull();
    expect(defaultEffortOf('kimi', [], 'k2')).toBeNull();
    /* A model that names no levels does not narrow what the Default model takes. */
    const models = [
      { id: 'a', name: 'A', efforts: ['low', 'high'] },
      { id: 'e', name: 'E', efforts: [] },
    ];
    expect(effortsOf(models, 'e')).toEqual([]);
    expect(effortsOf(models, '')).toEqual(['low', 'high']);
    /* A model the subscription does not run has no default of its own. */
    expect(defaultEffortOf('codex', [{ id: 'gpt-6.1-sol', name: 'Sol', defaultEffort: 'low' }], 'gone')).toBeNull();
    expect(defaultEffortOf('claude', [], 'gone')).toBeNull();
    expect(defaultEffortOf('kimi', [{ id: 'k', name: 'K', efforts: ['low', 'high'] }], 'gone')).toBeNull();
  });

  it('keeps the shared levels of the Default model in the order the first model lists them', () => {
    const models = [
      { id: 'a', name: 'A', efforts: ['high', 'low', 'max'] },
      { id: 'b', name: 'B', efforts: ['max', 'low', 'high', 'xhigh'] },
    ];
    expect(effortsOf(models, null)).toEqual(['high', 'low', 'max']);
    expect(defaultEffortOf('kimi', models, '')).toBeNull();
  });

  it('gives the web the same effort rule from a module without the message schemas', () => {
    expect(light).toBe(effortsOf);
    expect(lightEffort).toBe(effortFor);
  });
});

describe('live terminals', () => {
  it('round-trip the screen, the keys and the size between Hornhoof and a node', () => {
    const node: NodeMessage[] = [
      { type: 'hello', version: '0.6.0', loggedIn: true, running: [], terminals: true },
      { type: 'term.data', termId: 't-1', data: '\u001b[1mhi\u001b[0m ❯' },
      { type: 'term.exit', termId: 't-1' },
      { type: 'turn.open', agentKey: 'agent-1', text: 'Look at the build', ref: 'r-1' },
      { type: 'term.program', termId: 't-1', running: false },
    ];
    const server: ServerMessage[] = [
      { type: 'term.open', termId: 't-1', agentKey: 'agent-1', cols: 120, rows: 36, write: true },
      { type: 'term.input', termId: 't-1', data: 'hello\r' },
      { type: 'term.resize', termId: 't-1', cols: 80, rows: 24 },
      { type: 'term.close', termId: 't-1' },
      { type: 'turn.opened', agentKey: 'agent-1', jobId: 'job-9', toolToken: 'tok', ref: 'r-1' },
      { type: 'turn.opened', agentKey: 'agent-1', jobId: null, toolToken: null },
    ];
    for (const m of node) expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
    for (const m of server) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
  });

  it('refuse a terminal that is too big, an agent key that could leave its folder and more keys than one frame takes', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'term.open', termId: 't-1', agentKey: 'a', cols: 1000, rows: 36, write: false }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'term.open', termId: 't-1', agentKey: '../x', cols: 80, rows: 24, write: false }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'term.input', termId: 't-1', data: 'x'.repeat(70_000) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'turn.open', agentKey: 'a/b', text: 'x' }))).toBeNull();
  });

  it("carry Hornhoof's words for a running turn and whether they went into it", () => {
    const say: ServerMessage = { type: 'agent.say', agentKey: 'agent-1', text: 'Use the new schema.', ref: 'r-2' };
    const said: NodeMessage = { type: 'agent.said', ref: 'r-2', ok: true };
    expect(parseServerMessage(JSON.stringify(say))).toEqual(say);
    expect(parseNodeMessage(JSON.stringify(said))).toEqual(said);
    expect(parseServerMessage(JSON.stringify({ ...say, agentKey: '../x' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...say, text: 'x'.repeat(100_001) }))).toBeNull();
  });

  it('carry an optional time budget for words, in milliseconds', () => {
    const say = { type: 'agent.say', agentKey: 'agent-1', text: 'Use the new schema.', ref: 'r-2', within: 15_000 };
    expect(parseServerMessage(JSON.stringify(say))).toEqual(say);
    expect(parseServerMessage(JSON.stringify({ ...say, within: 0 }))).toEqual({ ...say, within: 0 });
    for (const within of [-1, 1.5, 'later', null]) expect(parseServerMessage(JSON.stringify({ ...say, within }))).toBeNull();
  });

  it("carry a restart of an agent's program and how it went", () => {
    const restart: ServerMessage = { type: 'agent.restart', agentKey: 'agent-1', jobId: 'job-1', note: 'Your program was restarted.' };
    const done: NodeMessage = { type: 'agent.restarted', agentKey: 'agent-1', jobId: 'job-1', ok: true, reason: null };
    const refused: NodeMessage = { ...done, ok: false, reason: 'A tool is running.' };
    expect(parseServerMessage(JSON.stringify(restart))).toEqual(restart);
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
    expect(parseNodeMessage(JSON.stringify(refused))).toEqual(refused);
    expect(parseServerMessage(JSON.stringify({ ...restart, agentKey: '../x' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...restart, note: 'x'.repeat(4001) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...done, reason: 'x'.repeat(301) }))).toBeNull();
  });

  it("carry what a turn's program does now, as its node sees it, with since when and when its screen last changed", () => {
    for (const state of PROGRAM_STATES) {
      const m: NodeMessage = { type: 'job.program', jobId: 'job-1', state, since: 1_793_379_000_000, screenAt: 1_793_379_030_000 };
      expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
    }
    expect(PROGRAM_STATES).toEqual(['thinking', 'tool', 'asking', 'retrying', 'idle', 'gone']);
    const tool: NodeMessage = { type: 'job.program', jobId: 'job-1', state: 'tool', since: 1_793_379_000_000, tool: 'Bash', screenAt: 1_793_379_030_000 };
    expect(parseNodeMessage(JSON.stringify(tool))).toEqual(tool);
    expect(parseNodeMessage(JSON.stringify({ ...tool, tool: 'x'.repeat(101) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...tool, state: 'asleep' }))).toBeNull();
    for (const at of [-1, 1.5, '1793379000000']) {
      expect(parseNodeMessage(JSON.stringify({ ...tool, since: at }))).toBeNull();
      expect(parseNodeMessage(JSON.stringify({ ...tool, screenAt: at }))).toBeNull();
    }
    /* The question the node used to answer is gone. */
    expect(parseServerMessage(JSON.stringify({ type: 'job.check', jobId: 'job-1' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.state', jobId: 'job-1', state: 'waiting' }))).toBeNull();
  });

  it("carry a program's own retry and its last sign of life", () => {
    const m: NodeMessage = { type: 'job.program', jobId: 'job-1', state: 'retrying', since: 1_793_379_000_000, screenAt: 1_793_379_030_000, signAt: 1_793_379_040_000, retry: { attempt: 2, max: 5, nextAt: 1_793_379_050_000 } };
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
    const unknown = { ...m, retry: { attempt: 1, max: null, nextAt: null } };
    expect(parseNodeMessage(JSON.stringify(unknown))).toEqual(unknown);
  });

  it('take a retrying program without the optional sign and retry details', () => {
    const m: NodeMessage = { type: 'job.program', jobId: 'job-1', state: 'retrying', since: 1_793_379_000_000, screenAt: 1_793_379_030_000 };
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });

  it('refuse a program retry whose attempt is zero', () => {
    const m = { type: 'job.program', jobId: 'job-1', state: 'retrying', since: 1_793_379_000_000, screenAt: 1_793_379_030_000, retry: { attempt: 0, max: 5, nextAt: null } };
    expect(parseNodeMessage(JSON.stringify(m))).toBeNull();
  });

  it("carry how a turn's program that is gone ended, and its last screen", () => {
    const gone: NodeMessage = { type: 'job.program', jobId: 'job-1', state: 'gone', since: 1_793_379_000_000, screenAt: 1_793_379_000_000, exitCode: 3, signal: null, screen: 'Error: out of memory' };
    expect(parseNodeMessage(JSON.stringify(gone))).toEqual(gone);
    const killed = { ...gone, exitCode: null, signal: 'SIGKILL' };
    expect(parseNodeMessage(JSON.stringify(killed))).toEqual(killed);
    /* A session gone whole tells neither. */
    const unknown = { ...gone, exitCode: null, signal: null };
    expect(parseNodeMessage(JSON.stringify(unknown))).toEqual(unknown);
    expect(PROGRAM_SCREEN_MAX).toBe(4000);
    expect(parseNodeMessage(JSON.stringify({ ...gone, screen: 'x'.repeat(PROGRAM_SCREEN_MAX) }))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...gone, screen: 'x'.repeat(PROGRAM_SCREEN_MAX + 1) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...gone, exitCode: 1.5 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...gone, signal: 'S'.repeat(41) }))).toBeNull();
  });

  it("carry how full an agent's context is, as a share", () => {
    const m: NodeMessage = { type: 'agent.context', agentKey: 'agent-1', used: 0.42 };
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
    expect(parseNodeMessage(JSON.stringify({ ...m, used: 1.2 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...m, used: -0.1 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...m, agentKey: '../x' }))).toBeNull();
  });
});

describe('plans on any machine', () => {
  const KEY = 'age1' + 'q'.repeat(58);
  const SEALED = '-----BEGIN AGE ENCRYPTED FILE-----\nabc\n-----END AGE ENCRYPTED FILE-----\n';

  it("carry the node's public key and the account its plan is signed in to", () => {
    const hello: NodeMessage = { type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY, account: { email: 'a@b.c', tier: 'pro' } };
    const status: NodeMessage = { type: 'status', loggedIn: true, limits: null, account: { email: null, tier: null } };
    expect(parseNodeMessage(JSON.stringify(hello))).toEqual(hello);
    expect(parseNodeMessage(JSON.stringify(status))).toEqual(status);
    expect(parseNodeMessage(JSON.stringify({ ...hello, publicKey: 'age2' + 'q'.repeat(58) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...hello, publicKey: 'age1' + 'Q'.repeat(58) }))).toBeNull();
  });

  it('still take a hello from a node before keys', () => {
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.8.0', loggedIn: false, running: [] }))).toMatchObject({ type: 'hello' });
  });

  it('carry a sign-in sealed for at most 20 nodes, and how the sign-in on a node ended', () => {
    const one = { nodeId: 'node-1', sealed: SEALED };
    const sealed: NodeMessage = { type: 'cred.sealed', kind: 'claude_token', version: 3, envelopes: [one, { ...one, nodeId: 'node-2' }] };
    expect(parseNodeMessage(JSON.stringify(sealed))).toEqual(sealed);
    expect(parseNodeMessage(JSON.stringify({ ...sealed, envelopes: Array.from({ length: 21 }, (_, i) => ({ ...one, nodeId: `n-${i}` })) }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...sealed, version: 0 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...sealed, envelopes: [{ ...one, nodeId: '../x' }] }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...sealed, envelopes: [{ ...one, sealed: 'x'.repeat(64 * 1024 + 1) }] }))).toBeNull();
    const done: NodeMessage = { type: 'login.done', ok: false, error: 'The sign-in window was closed.' };
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
    expect(parseNodeMessage(JSON.stringify({ ...done, error: 'x'.repeat(301) }))).toBeNull();
  });

  it('send a sealed sign-in, ask a node to seal what it holds, start and stop a sign-in and hand the Codex lease', () => {
    const msgs: ServerMessage[] = [
      { type: 'cred.put', kind: 'kimi_key', version: 1, sealed: SEALED },
      { type: 'cred.seal', kind: 'claude_token', version: 2, recipients: [{ nodeId: 'node-2', publicKey: KEY }] },
      { type: 'login.start', fresh: true },
      { type: 'login.stop' },
      { type: 'cred.lease', hold: true },
    ];
    for (const m of msgs) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
    expect(parseServerMessage(JSON.stringify({ ...msgs[0], kind: 'other' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...msgs[1], version: 0 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...msgs[1], recipients: [{ nodeId: 'node-2', publicKey: 'nope' }] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...msgs[1], recipients: Array.from({ length: 21 }, (_, i) => ({ nodeId: `n-${i}`, publicKey: KEY })) }))).toBeNull();
  });

  it('name the four kinds of sign-in a plan can carry', () => {
    expect(CRED_KINDS).toEqual(['claude_token', 'codex_auth', 'kimi_key', 'glm_key']);
  });

  it('carries a bounded browserError in hello and status when Chromium cannot start', () => {
    const hello = parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], browserError: 'libnss3.so: cannot open shared object file' }));
    expect(hello).toMatchObject({ type: 'hello', browserError: 'libnss3.so: cannot open shared object file' });
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], browserError: null }))).toMatchObject({ type: 'hello', browserError: null });
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], browserError: '' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], browserError: 'x'.repeat(301) }))).toBeNull();

    const status = parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: null, browserError: 'Executable missing', noRuns: 'Executable missing' }));
    expect(status).toMatchObject({ type: 'status', browserError: 'Executable missing', noRuns: 'Executable missing' });
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: null, browserError: null, noRuns: null }))).toMatchObject({ type: 'status', browserError: null, noRuns: null });
  });

  it('carries what a node observed across a connection drop and bounds every field', () => {
    expect(protocol.NODE_DISCONNECT_CAUSES).toEqual([
      'watchdog_timeout',
      'server_close',
      'socket_error',
      'dns_error',
      'handshake_timeout',
      'http_rejected',
      'abnormal_close',
    ]);
    const base = {
      type: 'node.reconnect' as const,
      disconnectedAt: '2026-11-04T19:00:00.000Z',
      reconnectedAt: '2026-11-04T19:00:12.500Z',
      offlineMs: 12_500,
      attempts: 3,
      cause: 'watchdog_timeout' as const,
      closeCode: 1006,
      closeReason: 'Replaced by a newer connection.',
      errorCode: 'ECONNRESET',
      error: 'read ECONNRESET',
      dnsFailed: true,
      watchdogTimedOut: true,
      clockJumpMs: 45_000,
      networkChanged: true,
    };
    expect(parseNodeMessage(JSON.stringify(base))).toEqual(base);

    const minimal = {
      ...base,
      offlineMs: 0,
      attempts: 1,
      closeCode: null,
      closeReason: null,
      errorCode: null,
      error: null,
      dnsFailed: false,
      watchdogTimedOut: false,
      clockJumpMs: null,
      networkChanged: false,
    };
    expect(parseNodeMessage(JSON.stringify(minimal))).toEqual(minimal);

    for (const cause of protocol.NODE_DISCONNECT_CAUSES) {
      expect(parseNodeMessage(JSON.stringify({ ...minimal, cause }))).toMatchObject({ cause });
    }
    expect(parseNodeMessage(JSON.stringify({ ...minimal, closeCode: 0 }))).toMatchObject({ closeCode: 0 });
    expect(parseNodeMessage(JSON.stringify({ ...minimal, closeCode: 65_535 }))).toMatchObject({ closeCode: 65_535 });
    expect(parseNodeMessage(JSON.stringify({ ...minimal, closeReason: 'x'.repeat(200) }))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...minimal, errorCode: 'A'.repeat(64) }))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...minimal, error: 'x'.repeat(300) }))).not.toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...minimal, clockJumpMs: 1 }))).toMatchObject({ clockJumpMs: 1 });

    for (const bad of [
      { disconnectedAt: 'nope' },
      { reconnectedAt: 'nope' },
      { offlineMs: -1 },
      { offlineMs: 1.5 },
      { attempts: 0 },
      { attempts: 1.5 },
      { cause: 'mystery' },
      { closeCode: -1 },
      { closeCode: 65_536 },
      { closeCode: 1000.5 },
      { closeReason: 'x'.repeat(201) },
      { closeReason: 'line1\nline2' },
      { errorCode: '' },
      { errorCode: 'A'.repeat(65) },
      { errorCode: 'bad code' },
      { errorCode: 'bad\ncode' },
      { error: 'x'.repeat(301) },
      { error: 'line1\nline2' },
      { clockJumpMs: 0 },
      { clockJumpMs: -5 },
      { clockJumpMs: 1.5 },
    ]) {
      expect(parseNodeMessage(JSON.stringify({ ...minimal, ...bad })), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('numbered node messages', () => {
  const event = { type: 'job.event', jobId: 'job-1', seq: 0, event: { kind: 'text', text: 'hi' } };
  const nodeMessage = (m: object) => parseNodeMessage(JSON.stringify(m));

  it('numbers what changes data and stays readable', () => {
    expect(nodeMessage({ ...event, n: 3 })).toMatchObject({ type: 'job.event', n: 3 });
    expect(nodeMessage(event)).toMatchObject({ type: 'job.event' });
    expect(nodeMessage({ type: 'hello', version: '1', loggedIn: true, running: [], stream: '8b1f6e1c-2d1c-4c9e-9a53-0f1d7f3f5a11' })).toMatchObject({ stream: '8b1f6e1c-2d1c-4c9e-9a53-0f1d7f3f5a11' });
    expect(parseServerMessage('{"type":"ack","upto":4}')).toEqual({ type: 'ack', upto: 4 });
    expect(parseServerMessage('{"type":"ack","upto":0}')).toEqual({ type: 'ack', upto: 0 });
    expect(nodeMessage({ ...event, n: 0 })).toBeNull();
    expect(nodeMessage({ ...event, n: 1.5 })).toBeNull();
    expect(nodeMessage({ ...event, n: 3, extra: 'x' })).not.toHaveProperty('extra');
  });

  it('takes a hello with as many runs and ends as a node can owe, and no more', () => {
    const hello = (running: string[], tests: string[]) => nodeMessage({ type: 'hello', version: '1', loggedIn: true, running, tests });
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `id-${i}`);
    expect(protocol.HELLO_IDS_BEFORE_ACKS).toBe(100);
    expect(protocol.HELLO_IDS_MAX).toBeGreaterThan(protocol.HELLO_IDS_BEFORE_ACKS);
    expect(hello(ids(protocol.HELLO_IDS_MAX), ids(protocol.HELLO_IDS_MAX))).not.toBeNull();
    expect(hello(ids(protocol.HELLO_IDS_MAX + 1), [])).toBeNull();
    expect(hello([], ids(protocol.HELLO_IDS_MAX + 1))).toBeNull();
  });

  it('leaves half of the 4 MiB a socket of the server takes for the rest of the longest hello', () => {
    const uuid = '8b1f6e1c-2d1c-4c9e-9a53-0f1d7f3f5a11';
    const hello = { type: 'hello', version: '1', loggedIn: true, running: Array(protocol.HELLO_IDS_MAX).fill(uuid), tests: Array(protocol.HELLO_IDS_MAX).fill(uuid) };
    expect(JSON.stringify(hello).length).toBeLessThan(2 * 1024 * 1024);
  });

  it('refuses an ack that is negative or not whole', () => {
    expect(parseServerMessage('{"type":"ack","upto":-1}')).toBeNull();
    expect(parseServerMessage('{"type":"ack","upto":2.5}')).toBeNull();
  });

  it('lets every message in NUMBERED carry n, and no other', () => {
    const samples: Record<string, object> = {
      'job.started': { type: 'job.started', jobId: 'j' },
      'job.event': event,
      'job.done': { type: 'job.done', jobId: 'j', ok: true, sessionId: null, result: '', tail: '', error: null },
      'tests.started': { type: 'tests.started', partId: 'p' },
      'tests.silent': { type: 'tests.silent', partId: '8b1f6e1c-2d1c-4c9e-9a53-0f1d7f3f5a11' },
      'tests.done': { type: 'tests.done', partId: 'p', ok: true, exitCode: 0, error: null, commit: null, log: '' },
      'cred.sealed': { type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [] },
      'login.done': { type: 'login.done', ok: true, error: null },
      'agent.context': { type: 'agent.context', agentKey: 'a', used: 0.5 },
      removed: { type: 'removed' },
      'job.program': { type: 'job.program', jobId: 'j', state: 'thinking', since: 1, screenAt: 1 },
      'agent.hook_rejected': { type: 'agent.hook_rejected', agentKey: 'a', event: 'stop', reason: 'no' },
      'agent.unheard': { type: 'agent.unheard', agentKey: 'a', jobId: null, text: 'hi' },
      'agent.said': { type: 'agent.said', ref: 'r', ok: true },
      'agent.restarted': { type: 'agent.restarted', agentKey: 'a', jobId: 'j', ok: true, reason: null },
      'node.stopping': { type: 'node.stopping', startedAt: '2026-11-04T10:00:00.000Z', exit: { kind: 'planned', reason: 'stopped', startedAt: null, at: null, log: '' } },
    };
    expect([...protocol.NUMBERED]).toEqual(['job.started', 'job.event', 'job.done', 'tests.started', 'tests.silent', 'tests.done', 'cred.sealed', 'login.done', 'agent.context', 'removed', 'job.program', 'agent.hook_rejected', 'agent.unheard']);
    for (const [type, sample] of Object.entries(samples)) {
      const parsed = nodeMessage({ ...sample, n: 7 });
      expect(parsed, type).not.toBeNull();
      expect('n' in parsed!, type).toBe(protocol.NUMBERED.includes(type as never));
      expect(protocol.isNumbered(nodeMessage(sample)!), type).toBe(protocol.NUMBERED.includes(type as never));
    }
  });

  it('names the header a server sends to say it confirms', () => {
    expect(protocol.ACKS_HEADER).toBe('hornhoof-acks');
  });
});
