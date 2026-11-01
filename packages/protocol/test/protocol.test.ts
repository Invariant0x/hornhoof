import { describe, expect, it } from 'vitest';
import { API_MODELS, CLAUDE_ALIASES, cut, defaultEffortOf, lastBytes, TAIL_BYTES, DEPARTMENT_TEMPLATES, effortFor, effortsOf, modelsFor, parseNodeMessage, parseServerMessage, repoFolder, type AgentEvent, type NodeMessage, type ServerMessage } from '../src/index.js';
import { effortsOf as light, topEffort as lightTop } from '../src/efforts.js';

const LIMITS = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.38, resetsAt: '2026-10-29T21:30:00.000Z' }] };

const NODE: NodeMessage[] = [
  { type: 'hello', version: '0.2.0', loggedIn: true, running: ['job-1'] },
  { type: 'status', loggedIn: false, limits: LIMITS },
  { type: 'status', loggedIn: true, limits: null },
  { type: 'hello', version: '0.4.0', loggedIn: true, running: [], models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
  { type: 'status', loggedIn: true, limits: null, models: [] },
  { type: 'job.started', jobId: 'job-1' },
  { type: 'job.done', jobId: 'job-1', ok: true, sessionId: 'abc', result: 'ready', tail: '', error: null },
  { type: 'job.done', jobId: 'job-2', ok: false, sessionId: null, result: '', tail: 'boom', error: 'timeout' },
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
  it('round-trip through JSON', () => {
    for (const m of NODE) expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for broken JSON, an unknown type or a missing field', () => {
    expect(parseNodeMessage('{nope')).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hack' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.done', jobId: 'x', ok: true }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: { status: 'fine', windows: [] } }))).toBeNull();
  });
});

describe('server messages', () => {
  it('round-trip through JSON', () => {
    for (const m of SERVER) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for a job without a timeout or an unknown provider', () => {
    const { timeoutMs: _, ...noTimeout } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
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

describe('calling a job off', () => {
  it('refuses an id with a slash', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'job.cancel', jobId: 'a/b' }))).toBeNull();
  });
});

describe('job.run', () => {
  it('carries the effort the agent thinks at, only as a plain level name', () => {
    const run = { ...(SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>), effort: 'max' };
    expect(parseServerMessage(JSON.stringify(run))).toEqual(run);
    expect(parseServerMessage(JSON.stringify({ ...run, effort: null }))).toEqual({ ...run, effort: null });
    expect(parseServerMessage(JSON.stringify({ ...run, effort: '--dangerously' }))).toBeNull();
  });

  it('needs instructions and a tool token, even when they are null', () => {
    const { instructions: _, ...noInstructions } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const { toolToken: __, ...noToken } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
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

  it("may name the author of the agents' commits, as one plain line and an address", () => {
    const run = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const repo = { url: 'https://github.com/acme/app.git', branch: 'main', token: '' };
    const author = { name: 'Ivan Korol', email: 'ivan@acme.dev' };
    const withAuthor = (a: unknown) => parseServerMessage(JSON.stringify({ ...run, workspace: { key: 'a1', repo: { ...repo, author: a } } }));
    expect(withAuthor(author)).toMatchObject({ workspace: { repo: { author } } });
    expect(withAuthor(null)).toMatchObject({ workspace: { repo: { author: null } } });
    expect(withAuthor({ ...author, name: 'Ivan\n[core]' })).toBeNull();
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
  it('are the eight starting departments, with operations always on', () => {
    expect(DEPARTMENT_TEMPLATES.map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.always).map(t => t.key)).toEqual(['operations']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.ticked).map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development']);
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
    const old = CLAUDE_ALIASES.map(({ defaultEffort: _, ...m }) => m);
    expect(['fable', 'opus', 'sonnet', 'haiku', ''].map(m => defaultEffortOf('claude', old, m))).toEqual(['high', 'medium', 'medium', 'medium', 'medium']);
    expect(['claude-fable-5-1', 'claude-opus-5-5', ''].map(m => defaultEffortOf('anthropic_api', API_MODELS.anthropic_api, m))).toEqual(['high', 'medium', 'medium']);
    /* Codex says it per model; its Default model and GLM's say nothing. */
    expect(defaultEffortOf('codex', [{ id: 'gpt-6.1-sol', name: 'Sol', defaultEffort: 'low' }], 'gpt-6.1-sol')).toBe('low');
    expect(defaultEffortOf('codex', [{ id: 'gpt-6.1-sol', name: 'Sol', defaultEffort: 'low' }], '')).toBeNull();
    expect(defaultEffortOf('glm', [], '')).toBeNull();
    expect(defaultEffortOf('kimi', [{ id: 'k3', name: 'K3', efforts: ['low', 'high'] }], 'k3')).toBe('high');
    expect(modelsFor('claude', old).map(m => m.defaultEffort)).toEqual(['high', 'medium', 'medium', 'medium']);
  });

  it('runs Kimi at its most unless a person picked less, and the others at their own default', () => {
    expect(effortFor('kimi', null)).toBe('max');
    expect(effortFor('kimi', 'low')).toBe('low');
    expect(effortFor('codex', null)).toBeNull();
    expect(effortFor('claude', 'xhigh')).toBe('xhigh');
  });

  it('keeps a picked effort only while the model takes it, and runs Kimi at the most its model takes', () => {
    expect(effortFor('kimi', 'xhigh', ['low', 'high', 'max'])).toBe('max');
    expect(effortFor('kimi', null, ['low', 'high'])).toBe('high');
    expect(effortFor('codex', 'ultra', ['low', 'medium'])).toBe('medium');
    expect(effortFor('codex', 'medium', ['low', 'medium'])).toBe('medium');
  });

  it('runs Codex at the most its model takes unless a person picked a level, and at its own default while its levels are not known', () => {
    const sol = { id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' };
    expect(effortFor('codex', null, sol.efforts)).toBe('xhigh');
    expect(effortFor('codex', 'low', sol.efforts)).toBe('low');
    expect(defaultEffortOf('codex', [sol], 'gpt-6.1-sol')).toBe('xhigh');
    /* The Default model takes only the levels every model takes. */
    expect(defaultEffortOf('codex', [sol, { id: 'gpt-6-luna', name: 'Luna', efforts: ['low', 'high'] }], '')).toBe('high');
    /* Codex may not take max, so a model that names no levels runs at the program's own. */
    expect(effortFor('codex', null, [])).toBeNull();
    /* Claude and an OpenAI key, which pays for each token, stay at their program's default. */
    expect(effortFor('claude', null, ['low', 'medium', 'high', 'xhigh', 'max'])).toBeNull();
    expect(effortFor('openai_api', null, ['low', 'medium', 'high', 'xhigh', 'max'])).toBeNull();
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
    /* No efforts known: a picked level goes through, Kimi runs at max. */
    expect(effortFor('codex', 'high', [])).toBe('high');
    expect(effortFor('kimi', null, [])).toBe('max');
    expect(defaultEffortOf('kimi', [], 'k2')).toBe('max');
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
    expect(defaultEffortOf('kimi', [{ id: 'k', name: 'K', efforts: ['low', 'high'] }], 'gone')).toBe('high');
  });

  it('keeps the shared levels of the Default model in the order the first model lists them', () => {
    const models = [
      { id: 'a', name: 'A', efforts: ['high', 'low', 'max'] },
      { id: 'b', name: 'B', efforts: ['max', 'low', 'high', 'xhigh'] },
    ];
    expect(effortsOf(models, null)).toEqual(['high', 'low', 'max']);
    expect(defaultEffortOf('kimi', [{ id: 'k', name: 'K', efforts: ['high', 'low'] }, { id: 'j', name: 'J', efforts: ['low', 'high'] }], '')).toBe('low');
  });

  it('gives the web the same effort rule from a module without the message schemas', () => {
    expect(light).toBe(effortsOf);
    expect(lightTop('codex', ['low', 'ultra'])).toBe(effortFor('codex', null, ['low', 'ultra']));
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

  it("carry how full an agent's context is, as a share", () => {
    const m: NodeMessage = { type: 'agent.context', agentKey: 'agent-1', used: 0.42 };
    expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
    expect(parseNodeMessage(JSON.stringify({ ...m, used: 1.2 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...m, used: -0.1 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...m, agentKey: '../x' }))).toBeNull();
  });
});
