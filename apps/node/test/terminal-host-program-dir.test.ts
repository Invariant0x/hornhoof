import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, ProviderId, ServerMessage, SkillFile } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toldPlace } from '../src/program-folder.js';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { runJob, type ProgramWorkspace, type ProviderAdapter } from '../src/runner.js';
import { readSessions } from '../src/state.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { RULES, taskTree } from './program-folder-helpers.js';
import { codexJob, hasTmux, home, host, job, kimiJob, SECRET, setUp, tmux } from './terminal-host-helpers.js';

const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}): TermJob => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key), signedOut: SIGNED_OUT });
const JOBS: Record<'claude' | 'codex' | 'kimi' | 'antigravity', (key: string, prompt: string) => TermJob> = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const KINDS = Object.keys(JOBS) as (keyof typeof JOBS)[];

const start = () => setUp({ readyMs: 5000, cols: 120, rows: 40, lookMs: 100 });
const realTree = (tracked?: Record<string, string>) => taskTree(realpathSync(mkdtempSync(join(tmpdir(), 'hh-tree-'))), tracked);
const bound = (programDir: string, more: Partial<ProgramWorkspace> = {}): ProgramWorkspace => ({ programDir, binding: { workspaceId: 'w-1', bindingVersion: 1 }, ...more });

type Turn = { sessionId?: string | null; skills?: SkillFile[]; jobId?: string };

/* One turn the way a node runs it: the runner over the host, with a fake of the program. */
async function turnOf(kind: keyof typeof JOBS, dir: string, key: string, workspace: ProgramWorkspace | undefined, { sessionId = null, skills, jobId = randomUUID() }: Turn = {}) {
  const j = JOBS[kind](key, 'hello');
  const adapter: ProviderAdapter = {
    install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [SECRET],
    run: input => host.run({ ...j, input: { ...input, env: { ...input.env, ...j.input.env } } }),
  };
  const message: Extract<ServerMessage, { type: 'job.run' }> = {
    type: 'job.run', jobId, subscriptionId: 'test', provider: kind as ProviderId, prompt: 'hello', sessionId, model: null, timeoutMs: 20_000,
    secret: null, instructions: 'Be brief.', toolToken: 'known-turn-token-0123456789', workspace: { key, repo: null }, ...(skills ? { skills } : {}),
  };
  const events: AgentEvent[] = [];
  const done = await runJob(adapter, message, dir, { toolsUrl: 'http://x/mcp', untimed: true, onEvent: event => events.push(event), superpowers: null, ...(workspace ? { workspace } : {}) });
  return { done, events, jobId };
}
const nodeDir = () => mkdtempSync(join(tmpdir(), 'hh-node-'));
const said = (events: AgentEvent[]) => events.flatMap(event => (event.kind === 'text' ? [event.text] : []));

describe.skipIf(!hasTmux)("a program in a task's folder", () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(KINDS)('%s works there, with git status clean and the repository\'s AGENTS.md as it was', async kind => {
    await start();
    const { context, tree, status } = realTree();
    const launch = vi.spyOn(tmux, 'launch');
    const { done } = await turnOf(kind, nodeDir(), randomUUID(), bound(tree));
    expect(done).toMatchObject({ ok: true, error: null });
    expect(launch.mock.calls[0]![1]).toMatchObject({ cwd: tree });
    expect(status()).toBe('');
    expect(readFileSync(join(tree, 'AGENTS.md'), 'utf8')).toBe(RULES);
    const place = toldPlace(kind, { workDir: context, programDir: tree });
    expect(readFileSync(place.file, 'utf8')).toBe(`${place.head}Be brief.\n`);
    expect(readdirSync(tree).filter(name => name.startsWith('.hh-'))).toEqual([]);
  }, 60_000);

  it.each(KINDS)('%s goes on in its session on the next turn there', async kind => {
    await start();
    const { tree } = realTree();
    const dir = nodeDir();
    const key = randomUUID();
    const launch = vi.spyOn(tmux, 'launch');
    const first = await turnOf(kind, dir, key, bound(tree));
    expect(first.done.sessionId).toBeTruthy();
    expect(readSessions(dir)[first.done.sessionId!]).toBe(tree);
    const second = await turnOf(kind, dir, key, bound(tree), { sessionId: first.done.sessionId });
    expect(second.done).toMatchObject({ ok: true, sessionId: first.done.sessionId });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(said(second.events).filter(text => text.includes('new session'))).toEqual([]);
  }, 60_000);

  it.each(KINDS)('%s starts anew there from a session of its old folder, says so, and the old session stays', async kind => {
    await start();
    const { context, tree, status } = realTree();
    const dir = nodeDir();
    const key = randomUUID();
    const old = await turnOf(kind, dir, key, undefined);
    const oldFolder = join(dir, 'work', 'agents', key);
    expect(readSessions(dir)[old.done.sessionId!]).toBe(oldFolder);
    const launch = vi.spyOn(tmux, 'launch');
    const moved = await turnOf(kind, dir, key, bound(tree, { catchUp: 'The task is about the checkout page.' }), { sessionId: old.done.sessionId });
    expect(moved.done.ok).toBe(true);
    expect(moved.done.sessionId).not.toBe(old.done.sessionId);
    expect(launch.mock.calls[0]![1]).toMatchObject({ cwd: tree });
    expect(said(moved.events).join('\n')).toContain('new session');
    expect(readFileSync(toldPlace(kind, { workDir: context, programDir: tree }).file, 'utf8')).toContain('The task is about the checkout page.');
    expect(readSessions(dir)[old.done.sessionId!]).toBe(oldFolder);
    expect(readSessions(dir)[moved.done.sessionId!]).toBe(tree);
    expect(status()).toBe('');
  }, 60_000);

  it('starts its own program in another task\'s folder', async () => {
    await start();
    const one = realTree();
    const two = realTree();
    const dir = nodeDir();
    const key = randomUUID();
    const first = await turnOf('claude', dir, key, bound(one.tree));
    const launch = vi.spyOn(tmux, 'launch');
    const second = await turnOf('claude', dir, key, bound(two.tree, { binding: { workspaceId: 'w-2', bindingVersion: 1 } }), { sessionId: first.done.sessionId });
    expect(second.done.ok).toBe(true);
    expect(second.done.sessionId).not.toBe(first.done.sessionId);
    expect(launch.mock.calls[0]![1]).toMatchObject({ cwd: two.tree });
  }, 60_000);

  it('holds the binding of its task, which retiring the program goes by', async () => {
    await start();
    const { tree } = realTree();
    const key = randomUUID();
    const { jobId } = await turnOf('claude', nodeDir(), key, bound(tree));
    const request = { agentKey: key, expectedInstance: host.instanceOf(key)!, expectedJobId: jobId, workspaceId: 'w-1', bindingVersion: 1 };
    await expect(host.retireIdleWorkspace({ ...request, workspaceId: 'w-other' })).resolves.toMatchObject({ status: 'stale' });
    await expect(host.retireIdleWorkspace(request)).resolves.toEqual({ status: 'retired', instanceGone: true });
  }, 60_000);

  it.each([['claude', '.claude/skills'], ['codex', '.agents/skills'], ['kimi', '.agents/skills'], ['antigravity', '.agents/skills']] as const)('%s finds the agent\'s skills there, out of git status', async (kind, folder) => {
    await start();
    const { tree, status } = realTree();
    const skills: SkillFile[] = [{ name: 'review', description: 'How to review', body: 'Read it all.' }];
    const { done } = await turnOf(kind, nodeDir(), randomUUID(), bound(tree), { skills });
    expect(done.ok).toBe(true);
    expect(existsSync(join(tree, folder, 'review', 'SKILL.md'))).toBe(true);
    expect(status()).toBe('');
  }, 60_000);

  it('does not start when the repository tracks a file it would have to write over', async () => {
    await start();
    const { tree, status } = realTree({ '.agents/hooks.json': '{"theirs":true}\n' });
    const launch = vi.spyOn(tmux, 'launch');
    const { done } = await turnOf('antigravity', nodeDir(), randomUUID(), bound(tree));
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain('.agents/hooks.json');
    expect(launch).not.toHaveBeenCalled();
    expect(readFileSync(join(tree, '.agents', 'hooks.json'), 'utf8')).toBe('{"theirs":true}\n');
    expect(status()).toBe('');
  }, 60_000);

  it('does not start when the task\'s folder is not there', async () => {
    await start();
    const { tree } = realTree();
    const launch = vi.spyOn(tmux, 'launch');
    const { done } = await turnOf('claude', nodeDir(), randomUUID(), bound(join(tree, 'gone')));
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(launch).not.toHaveBeenCalled();
  }, 60_000);

  it('keeps a word that did not fit in the context folder, out of the repository', async () => {
    await start();
    const { context, tree, status } = realTree();
    const key = randomUUID();
    await turnOf('claude', nodeDir(), key, bound(tree));
    const agent = host['agents'].get(key)!;
    agent.typing = 'The whole of a long message.';
    const told = await host['promptGot'](agent, 'The whole');
    expect(told).toContain(join(context, '.hh-messages'));
    expect(readdirSync(join(context, '.hh-messages'))).toHaveLength(1);
    expect(status()).toBe('');
  }, 60_000);
});
