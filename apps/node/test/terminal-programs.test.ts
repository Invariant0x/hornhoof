import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownFs, type AgentFs } from '../src/agent-fs.js';
import { credentialSecrets } from '../src/credentials.js';
import { StreamMask } from '../src/terminal/mask.js';
import { acceptClaudeDialogs, agyProgram, claudePlanLimits, claudeProgram, claudeTranscript, codexProgram, findKimiWire, findRollout, kimiPlanLimits, kimiProgram, prepareAgy, prepareKimi } from '../src/terminal/programs.js';
import { listenIn } from '../../../test-support/ports.mjs';

const URLS = { mcpUrl: 'http://127.0.0.1:5000/mcp/s3cr3t', attachUrl: 'http://127.0.0.1:5000/attach/s3cr3t', hookUrl: 'http://127.0.0.1:5000/hook/s3cr3t' };
const arg = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

describe('program updates managed outside the agent terminal', () => {
  const launch = { bin: '/t/program', home: '/h', workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS };

  it('disables Claude Code self-updates in its terminal environment', () => {
    expect(claudeProgram.launch(launch).env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('enables the explicit Kimi program status independently of hooks', () => {
    expect(kimiProgram.launch(launch).env.PI_PROGRAM_STATUS).toBe('1');
  });

  it('disables Kimi self-updates in its terminal environment', () => {
    expect(kimiProgram.launch(launch).env).toMatchObject({ KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' });
  });

  it.each([null, 'existing-session'])('disables Codex startup updates with session %s', sessionId => {
    const { command } = codexProgram.launch({ ...launch, sessionId });
    expect(command).toContain('check_for_update_on_startup=false');
    expect(command[command.indexOf('check_for_update_on_startup=false') - 1]).toBe('-c');
  });

  it.each([null, 'existing-session'])('keeps Codex from asking which model to go on with near its limits, with session %s', sessionId => {
    const { command } = codexProgram.launch({ ...launch, sessionId });
    expect(command[command.indexOf('notice.hide_rate_limit_model_nudge=true') - 1]).toBe('-c');
  });
});

/* tmux keeps no history of an alternate screen, so a person's view would have nothing to scroll back to. */
describe('programs that leave their conversation in the history of the terminal', () => {
  const launch = { bin: '/t/program', home: '/h', workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS };

  it.each([null, 'existing-session'])('keeps Claude Code on the main screen with session %s', sessionId => {
    expect(claudeProgram.launch({ ...launch, sessionId }).env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1');
  });

  it.each([null, 'existing-session'])('keeps Codex on the main screen with session %s', sessionId => {
    expect(codexProgram.launch({ ...launch, sessionId }).command).toContain('--no-alt-screen');
  });
});

describe('Claude Code in a terminal', () => {
  it('starts a new session with a known id, its instructions, the bridge for tools and hooks', () => {
    const { command, env, sessionId } = claudeProgram.launch({ bin: '/t/claude', home: '/h', workDir: '/w/a1', sessionId: null, model: 'opus', instructionsFile: '/w/a1/.hh-instructions.md', urls: URLS });
    expect(command[0]).toBe('/t/claude');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg(command, '--session-id')).toBe(sessionId);
    expect(command).toContain('--dangerously-skip-permissions');
    expect(command).toContain('--strict-mcp-config');
    expect(JSON.parse(arg(command, '--mcp-config')!)).toEqual({ mcpServers: { hornhoof: { type: 'http', url: URLS.mcpUrl } } });
    const settings = JSON.parse(arg(command, '--settings')!);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('hh-hook stop');
    expect(settings.hooks.StopFailure).toEqual([{ hooks: [{ type: 'command', command: 'hh-hook stop' }] }]);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('hh-hook prompt');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('hh-hook start');
    /* After compacting its conversation it hears to read the company again. */
    expect(settings.hooks.SessionStart[1]).toEqual({ matcher: 'compact', hooks: [{ type: 'command', command: 'hh-hook compact' }] });
    expect(settings.statusLine).toEqual({ type: 'command', command: 'hh-hook status' });
    expect(arg(command, '--append-system-prompt-file')).toBe('/w/a1/.hh-instructions.md');
    expect(arg(command, '--model')).toBe('opus');
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/h', HH_BRIDGE: URLS.hookUrl, HH_ATTACH_URL: URLS.attachUrl, COLORTERM: 'truecolor' });
  });

  it("starts with the plan's sign-in its node was given, which the screen never shows", () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-home-'));
    const token = 'sk-ant-oat01-' + 'c'.repeat(40);
    expect(claudeProgram.launch({ bin: 'claude', home, workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS }).env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    writeFileSync(join(home, 'claude-oauth-token'), token + '\n', { mode: 0o600 });
    expect(claudeProgram.launch({ bin: 'claude', home, workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    const mask = new StreamMask(() => credentialSecrets(home));
    expect(mask.push(`$ echo $CLAUDE_CODE_OAUTH_TOKEN\r\n${token}\r\n$ `) + mask.flush()).toBe('$ echo $CLAUDE_CODE_OAUTH_TOKEN\r\n[hidden]\r\n$ ');
  });

  it('goes on with the session it had, and leaves the model to the plan when none is set', () => {
    const { command, sessionId } = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: 'abc-1', model: null, instructionsFile: null, urls: URLS });
    expect(arg(command, '--resume')).toBe('abc-1');
    expect(sessionId).toBe('abc-1');
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--model');
    expect(command).not.toContain('--append-system-prompt-file');
  });

  it("loads no plugin, new or resumed, so every hook of the session is Hornhoof's own", () => {
    for (const sessionId of [null, 'abc-1']) {
      const { command } = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId, model: null, instructionsFile: null, urls: URLS });
      expect(command).not.toContain('--plugin-dir');
      const { hooks } = JSON.parse(arg(command, '--settings')!) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      for (const command of Object.values(hooks).flat().flatMap(entry => entry.hooks.map(h => h.command))) expect(command).toMatch(/^hh-hook [a-z]+$/);
    }
  });

  it('names Claude as co-author of no commit or pull request, new or resumed', () => {
    for (const sessionId of [null, 'abc-1']) {
      const { command } = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId, model: null, instructionsFile: null, urls: URLS });
      const settings = JSON.parse(arg(command, '--settings')!);
      expect(settings.attribution).toEqual({ commit: '', pr: '' });
      expect(settings.includeCoAuthoredBy).toBe(false);
    }
  });

  it('thinks as hard as the agent was set to, or at the plan default when nothing is set', () => {
    const set = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: null, model: null, effort: 'max', instructionsFile: null, urls: URLS });
    expect(arg(set.command, '--effort')).toBe('max');
    const unset = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: null, model: null, effort: null, instructionsFile: null, urls: URLS });
    expect(unset.command).not.toContain('--effort');
  });

  it('compacts the conversation at the window Hornhoof set, or at its own when none is set', () => {
    const set = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: null, model: null, compactWindow: 500_000, instructionsFile: null, urls: URLS });
    expect(set.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
    const unset = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS });
    expect(unset.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  it("answers the first-run questions before they are asked, keeping the person's own settings", async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { a: 1 }, projects: { '/other': { allowedTools: ['x'] } } }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: 'light', env: { A: '1' } }));
    await acceptClaudeDialogs(home, '/w/a1');
    const state = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(state).toMatchObject({ oauthAccount: { a: 1 }, hasCompletedOnboarding: true, projects: { '/other': { allowedTools: ['x'] }, '/w/a1': { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({ theme: 'light', env: { A: '1' }, skipDangerousModePermissionPrompt: true });
  });

  it('keeps the trust of every agent that starts at the same time in one home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    await Promise.all(['/w/a1', '/w/a2', '/w/a3'].map(dir => acceptClaudeDialogs(home, dir)));
    const { projects } = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(projects).sort()).toEqual(['/w/a1', '/w/a2', '/w/a3']);
  });

  it('answers them on a fresh home too, in the dark theme a first run picks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    await acceptClaudeDialogs(home, '/w/a1');
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true });
  });

  it("asks Claude's usage page for the plan's limits with the token Claude keeps, and gives nothing without one", async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(`${req.url} ${req.headers.authorization} ${req.headers['anthropic-beta']}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ five_hour: { utilization: 40, resets_at: '2026-10-31T03:00:00Z' }, seven_day: { utilization: 93, resets_at: '2026-11-01T07:00:00Z' } }));
    });
    await listenIn(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await claudePlanLimits(home, base)).toBeNull();
      const signIn = (token: string, expiresAt: number) => writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'refresh', expiresAt } }));
      signIn('claude-access-1', Date.now() + 600_000);
      expect(await claudePlanLimits(home, base)).toEqual({
        status: 'allowed',
        windows: [
          { name: 'five_hour', utilization: 0.4, resetsAt: '2026-10-31T03:00:00.000Z' },
          { name: 'seven_day', utilization: 0.93, resetsAt: '2026-11-01T07:00:00.000Z' },
        ],
        complete: true,
      });
      /* Claude Code alone renews its token while it runs; one that ran out would only be refused. */
      signIn('claude-access-2', Date.now() - 60_000);
      expect(await claudePlanLimits(home, base)).toBeNull();
      /* A plan signed in from Hornhoof keeps its one-year token in claude-oauth-token instead of .credentials.json. */
      const longToken = 'sk-ant-oat01-' + 'd'.repeat(40);
      writeFileSync(join(home, 'claude-oauth-token'), longToken + '\n', { mode: 0o600 });
      expect(await claudePlanLimits(home, base)).toMatchObject({ status: 'allowed', complete: true });
      expect(asked).toEqual([
        '/api/oauth/usage Bearer claude-access-1 oauth-2025-04-20',
        `/api/oauth/usage Bearer ${longToken} oauth-2025-04-20`,
      ]);
    } finally {
      server.close();
    }
  });

  it('keeps its log where Claude Code puts it for the folder', () => {
    expect(claudeTranscript('/data/home', '/data/work/agents/a-1', 's1')).toBe('/data/home/projects/-data-work-agents-a-1/s1.jsonl');
  });
});

describe('Codex in a terminal', () => {
  it('starts in the agent folder with the bridge for tools, or resumes its session', () => {
    const first = codexProgram.launch({ bin: '/t/codex', home: '/h', workDir: '/w/a2', sessionId: null, model: 'gpt-6.1-sol', instructionsFile: null, urls: URLS });
    expect(first.command.slice(0, 2)).toEqual(['/t/codex', '--dangerously-bypass-approvals-and-sandbox']);
    expect(arg(first.command, '-C')).toBe('/w/a2');
    expect(first.command).toContain(`mcp_servers.hornhoof.url=${JSON.stringify(URLS.mcpUrl)}`);
    expect(arg(first.command, '-m')).toBe('gpt-6.1-sol');
    expect(first.sessionId).toBeNull();
    expect(first.env).toMatchObject({ CODEX_HOME: '/h', HH_ATTACH_URL: URLS.attachUrl });
    const again = codexProgram.launch({ bin: '/t/codex', home: '/h', workDir: '/w/a2', sessionId: 'th-9', model: null, instructionsFile: null, urls: URLS });
    expect(again.command.slice(0, 3)).toEqual(['/t/codex', 'resume', 'th-9']);
    expect(again.command).not.toContain('-C');
  });

  it('reads all of AGENTS.md, which Codex cuts at 32 KiB unless told otherwise', () => {
    for (const sessionId of [null, 'th-9']) {
      const { command } = codexProgram.launch({ bin: 'codex', home: '/h', workDir: '/w', sessionId, model: null, instructionsFile: null, urls: URLS });
      expect(command[command.indexOf('project_doc_max_bytes=1048576') - 1]).toBe('-c');
    }
  });

  it('thinks as hard as the agent was set to, in a new session and a resumed one', () => {
    const first = codexProgram.launch({ bin: 'codex', home: '/h', workDir: '/w', sessionId: null, model: null, effort: 'xhigh', instructionsFile: null, urls: URLS });
    expect(first.command).toContain('model_reasoning_effort="xhigh"');
    expect(first.command[first.command.indexOf('model_reasoning_effort="xhigh"') - 1]).toBe('-c');
    const again = codexProgram.launch({ bin: 'codex', home: '/h', workDir: '/w', sessionId: 'th-9', model: null, effort: 'low', instructionsFile: null, urls: URLS });
    expect(again.command).toContain('model_reasoning_effort="low"');
    const unset = codexProgram.launch({ bin: 'codex', home: '/h', workDir: '/w', sessionId: null, model: null, effort: null, instructionsFile: null, urls: URLS });
    expect(unset.command.join(' ')).not.toContain('model_reasoning_effort');
  });

  it("finds the log of the session it started in the agent's folder", () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-codex-'));
    const day = join(home, 'sessions', '2026', '10', '30');
    mkdirSync(day, { recursive: true });
    const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n';
    writeFileSync(join(day, 'rollout-a.jsonl'), meta('th-old', '/w/a2'));
    utimesSync(join(day, 'rollout-a.jsonl'), new Date(1000), new Date(1000));
    writeFileSync(join(day, 'rollout-b.jsonl'), meta('th-other', '/w/b'));
    writeFileSync(join(day, 'rollout-c.jsonl'), meta('th-new', '/w/a2'));
    expect(findRollout(home, '/w/a2', Date.now() - 60_000)).toEqual({ file: join(day, 'rollout-c.jsonl'), sessionId: 'th-new' });
    expect(findRollout(home, '/w/zzz', 0)).toBeNull();
  });
});

describe('Antigravity CLI in a terminal', () => {
  it('runs agy itself with session trust, no feedback survey, model and effort, and resumes its conversation', () => {
    const base = { bin: '/t/agy', home: '/h', workDir: '/w/g1', instructionsFile: null, urls: URLS };
    const trust = ['--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: ['/w/g1'], showFeedbackSurvey: false })];
    const first = agyProgram.launch({ ...base, sessionId: null, model: 'gemini-4-argon', effort: 'high' });
    expect(first.command).toEqual(['/t/agy', '--model', 'gemini-4-argon', '--effort', 'high', ...trust]);
    expect(first.sessionId).toBeNull();
    expect(first.env).toEqual({ HOME: '/h', AGY_CLI_DISABLE_AUTO_UPDATE: 'true', HH_BRIDGE: URLS.hookUrl, HH_ATTACH_URL: URLS.attachUrl, HH_ATTACH_PASS: 'bridge', COLORTERM: 'truecolor' });
    const again = agyProgram.launch({ ...base, sessionId: 'conversation-1', model: null });
    expect(again.command).toEqual(['/t/agy', '--conversation', 'conversation-1', ...trust]);
    expect(again.sessionId).toBe('conversation-1');
  });

  it('writes MCP and invocation and stop hooks in the agent folder without a print log', async () => {
    const work = mkdtempSync(join(tmpdir(), 'agy-work-'));
    await prepareAgy(work, URLS.mcpUrl);
    expect(JSON.parse(readFileSync(join(work, '.agents', 'mcp_config.json'), 'utf8'))).toEqual({ mcpServers: { hornhoof: { serverUrl: URLS.mcpUrl } } });
    expect(JSON.parse(readFileSync(join(work, '.agents', 'hooks.json'), 'utf8'))).toEqual({ hornhoof: {
      PreInvocation: [{ type: 'command', command: 'hh-hook invocation' }], Stop: [{ type: 'command', command: 'hh-hook stop' }],
    } });
    expect(existsSync(join(work, '.hh-agy.jsonl'))).toBe(false);
  });

  it("reads the plan's limits through agy, and gives nothing when agy is absent or fails", async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-limits-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    expect(await agyProgram.limits!(home)).toBeNull();
    const bin = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
    expect(await agyProgram.limits!(home, { bin })).toMatchObject({
      status: 'allowed',
      complete: true,
      windows: [
        { name: 'five_hour', resetsAt: '2026-11-04T21:41:44.000Z' },
        { name: 'seven_day', resetsAt: '2026-11-10T00:41:44.000Z' },
      ],
    });
    writeFileSync(join(home, '.fake-limits-mode'), 'fail');
    expect(await agyProgram.limits!(home, { bin })).toBeNull();
  });
});

describe('Kimi Code in a terminal', () => {
  it('starts deciding on its own in the agent folder, or resumes its session', () => {
    const first = kimiProgram.launch({ bin: '/t/kimi', home: '/h', workDir: '/w/a3', sessionId: null, model: 'kimi-k3', instructionsFile: null, urls: URLS });
    expect(first.command).toEqual(['/t/kimi', '--auto', '-m', 'kimi-k3']);
    /* Kimi names a new session when the first message starts it. */
    expect(first.sessionId).toBeNull();
    expect(first.env).toMatchObject({ KIMI_CODE_HOME: '/h', KIMI_CODE_TRUST_WORKSPACE: '1', HH_BRIDGE: URLS.hookUrl, HH_ATTACH_URL: URLS.attachUrl });
    const again = kimiProgram.launch({ bin: '/t/kimi', home: '/h', workDir: '/w/a3', sessionId: 'session_9', model: null, instructionsFile: null, urls: URLS });
    expect(again.command).toEqual(['/t/kimi', '--auto', '-S', 'session_9']);
    expect(again.sessionId).toBe('session_9');
  });

  it('thinks as hard as the agent was set to through the setting Kimi reads from its env', () => {
    const set = kimiProgram.launch({ bin: 'kimi', home: '/h', workDir: '/w', sessionId: null, model: null, effort: 'max', instructionsFile: null, urls: URLS });
    expect(set.env.KIMI_MODEL_THINKING_EFFORT).toBe('max');
    expect(set.command).toEqual(['kimi', '--auto']);
    const unset = kimiProgram.launch({ bin: 'kimi', home: '/h', workDir: '/w', sessionId: null, model: null, effort: null, instructionsFile: null, urls: URLS });
    expect(unset.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
  });

  it("gives the agent folder the bridge for tools, and adds Hornhoof's hooks to the person's settings once", async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    const work = mkdtempSync(join(tmpdir(), 'hh-kimi-work-'));
    const own = 'default_model = "kimi-code/k3"\n\n[providers."managed:kimi-code"]\ntype = "kimi"\n';
    writeFileSync(join(home, 'config.toml'), own);
    await prepareKimi(home, work, URLS.mcpUrl);
    await prepareKimi(home, work, URLS.mcpUrl);
    expect(JSON.parse(readFileSync(join(work, '.kimi-code', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { hornhoof: { transport: 'http', url: URLS.mcpUrl } } });
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(config.startsWith(own)).toBe(true);
    expect(config.match(/\[\[hooks\]\]/g)).toHaveLength(10);
    expect(config).toContain('event = "SessionStart"\ncommand = "hh-hook start"');
    expect(config).toContain('event = "UserPromptSubmit"\ncommand = "hh-hook prompt"');
    expect(config).toContain('event = "UserPromptQueued"\ncommand = "hh-hook queued"');
  });

  it('adds UserPromptQueued to existing hooks and leaves an installed receipt hook alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    const work = mkdtempSync(join(tmpdir(), 'hh-kimi-work-'));
    await prepareKimi(home, work, URLS.mcpUrl);
    const file = join(home, 'config.toml');
    const old = readFileSync(file, 'utf8').replace(/\[\[hooks\]\]\nevent = "UserPromptQueued"\ncommand = "hh-hook queued"\n\n?/, '');
    writeFileSync(file, old);
    await prepareKimi(home, work, URLS.mcpUrl);
    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('event = "UserPromptQueued"\ncommand = "hh-hook queued"');
    await prepareKimi(home, work, URLS.mcpUrl);
    expect(readFileSync(file, 'utf8')).toBe(updated);
  });

  it('adds the hooks to a fresh home, and leaves settings alone that list hooks in a way more could not be added to', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    await prepareKimi(fresh, mkdtempSync(join(tmpdir(), 'hh-kimi-work-')), URLS.mcpUrl);
    expect(readFileSync(join(fresh, 'config.toml'), 'utf8')).toContain('command = "hh-hook prompt"');
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    const own = 'hooks = [{ event = "Stop", command = "say done" }]\n';
    writeFileSync(join(home, 'config.toml'), own);
    await prepareKimi(home, mkdtempSync(join(tmpdir(), 'hh-kimi-work-')), URLS.mcpUrl);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(own);
  });

  it("does the first-run answers and Kimi's files through the agents' file helper", async () => {
    const done: string[] = [];
    const fs: AgentFs = {
      mkdir: path => (done.push(`mkdir ${path}`), ownFs.mkdir(path)),
      read: path => (done.push(`read ${path}`), ownFs.read(path)),
      write: (path, data) => (done.push(`write ${path}`), ownFs.write(path, data)),
      kind: ownFs.kind,
      entry: ownFs.entry,
      readPlain: ownFs.readPlain,
      remove: ownFs.remove,
      copy: ownFs.copy,
      move: ownFs.move,
      stop() {},
    };
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    await acceptClaudeDialogs(home, '/w/a1', fs);
    expect(done).toEqual([`read ${join(home, '.claude.json')}`, `write ${join(home, '.claude.json')}`, `read ${join(home, 'settings.json')}`, `write ${join(home, 'settings.json')}`]);
    done.length = 0;
    const kimi = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    const work = mkdtempSync(join(tmpdir(), 'hh-kimi-work-'));
    await prepareKimi(kimi, work, URLS.mcpUrl, fs);
    expect(done).toEqual([`mkdir ${join(work, '.kimi-code')}`, `write ${join(work, '.kimi-code', 'mcp.json')}`, `read ${join(kimi, 'config.toml')}`, `mkdir ${kimi}`, `write ${join(kimi, 'config.toml')}`]);
  });

  it("asks Kimi's usage page for the plan's limits with the token Kimi keeps, and gives nothing without one", async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    expect(await kimiPlanLimits(home)).toBeNull();
    const auths: string[] = [];
    const server = createServer((req, res) => {
      auths.push(`${req.url} ${req.headers.authorization}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ usages: { limit_5h: { used_ratio: 0.5, reset_time: '2026-10-31T03:00:00Z' } } }));
    });
    await listenIn(server);
    const before = process.env.KIMI_CODE_BASE_URL;
    process.env.KIMI_CODE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/coding/v1`;
    try {
      mkdirSync(join(home, 'credentials'));
      writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'kimi-access-1', refresh_token: 'kimi-refresh-1' }));
      expect(await kimiPlanLimits(home)).toEqual({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.5, resetsAt: '2026-10-31T03:00:00.000Z' }], complete: true });
      expect(auths).toEqual(['/coding/v1/usages Bearer kimi-access-1']);
      /* A token that ran out asks nothing: Kimi alone renews it, and the last limits stay. */
      writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'kimi-access-2', refresh_token: 'kimi-refresh-2', expires_at: Date.now() / 1000 - 60 }));
      expect(await kimiPlanLimits(home)).toBeNull();
      writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'kimi-access-3', refresh_token: 'kimi-refresh-3', expires_at: Date.now() / 1000 + 600 }));
      expect(await kimiPlanLimits(home)).not.toBeNull();
      expect(auths).toEqual(['/coding/v1/usages Bearer kimi-access-1', '/coding/v1/usages Bearer kimi-access-3']);
    } finally {
      if (before === undefined) delete process.env.KIMI_CODE_BASE_URL;
      else process.env.KIMI_CODE_BASE_URL = before;
      server.close();
    }
  });

  it('finds the log of a session in whichever workspace Kimi keeps it', () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-'));
    const dir = join(home, 'sessions', 'wd_a3_0123456789ab', 'session_1', 'agents', 'main');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'wire.jsonl'), '{"type":"metadata"}\n');
    expect(findKimiWire(home, 'session_1')).toBe(join(dir, 'wire.jsonl'));
    expect(findKimiWire(home, 'session_2')).toBeNull();
    expect(findKimiWire(home, '../x')).toBeNull();
  });
});

describe('lifecycle hooks in launch settings', () => {
  const launch = { bin: 'program', home: '/h', workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: URLS };
  it('configures Claude tool, permission and session ends', () => {
    const settings = JSON.parse(arg(claudeProgram.launch(launch).command, '--settings')!);
    for (const [name, event] of Object.entries({ PreToolUse: 'tool', PostToolUse: 'tooldone', PostToolUseFailure: 'toolfail', PermissionRequest: 'ask', SessionEnd: 'end' })) {
      expect(settings.hooks[name]).toEqual([{ hooks: [{ type: 'command', command: `hh-hook ${event}` }] }]);
    }
  });
  it('configures exactly the five Codex hooks with inline TOML and bypasses hook trust', () => {
    const command = codexProgram.launch(launch).command;
    expect(command).toContain('--dangerously-bypass-hook-trust');
    expect(command.filter(s => s.startsWith('hooks.'))).toEqual(Object.entries({ Stop: 'stop', Interrupt: 'interrupt', PreToolUse: 'tool', PostToolUse: 'tooldone', SessionEnd: 'end' }).map(([name, event]) => `hooks.${name}=[{hooks=[{type="command",command="hh-hook ${event}"}]}]`));
  });
  it('upgrades the two existing Kimi hooks once, including both stop events', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-kimi-hooks-'));
    const work = mkdtempSync(join(tmpdir(), 'hh-kimi-work-'));
    writeFileSync(join(home, 'config.toml'), '[[hooks]]\nevent = "SessionStart"\ncommand = "hh-hook start"\n\n[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "hh-hook prompt"\n');
    await prepareKimi(home, work, URLS.mcpUrl);
    await prepareKimi(home, work, URLS.mcpUrl);
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    expect([...config.matchAll(/event = "([^"]+)"/g)].map(m => m[1])).toEqual(['SessionStart', 'UserPromptSubmit', 'UserPromptQueued', 'Stop', 'StopFailure', 'Interrupt', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd']);
    expect(config).not.toContain('SessionHeartbeat');
  });
});
