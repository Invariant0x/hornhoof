import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptClaudeDialogs, claudeProgram, claudeTranscript, codexProgram, findRollout } from '../src/terminal/programs.js';

const URLS = { mcpUrl: 'http://127.0.0.1:5000/mcp/s3cr3t', attachUrl: 'http://127.0.0.1:5000/attach/s3cr3t', hookUrl: 'http://127.0.0.1:5000/hook/s3cr3t' };
const arg = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

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
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('hh-hook prompt');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('hh-hook start');
    expect(settings.statusLine).toEqual({ type: 'command', command: 'hh-hook status' });
    expect(arg(command, '--append-system-prompt-file')).toBe('/w/a1/.hh-instructions.md');
    expect(arg(command, '--model')).toBe('opus');
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/h', HH_BRIDGE: URLS.hookUrl, HH_ATTACH_URL: URLS.attachUrl, COLORTERM: 'truecolor' });
  });

  it('goes on with the session it had, and leaves the model to the plan when none is set', () => {
    const { command, sessionId } = claudeProgram.launch({ bin: 'claude', home: '/h', workDir: '/w', sessionId: 'abc-1', model: null, instructionsFile: null, urls: URLS });
    expect(arg(command, '--resume')).toBe('abc-1');
    expect(sessionId).toBe('abc-1');
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--model');
    expect(command).not.toContain('--append-system-prompt-file');
  });

  it("answers the first-run questions before they are asked, keeping the person's own settings", () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { a: 1 }, projects: { '/other': { allowedTools: ['x'] } } }));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: 'light', env: { A: '1' } }));
    acceptClaudeDialogs(home, '/w/a1');
    const state = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(state).toMatchObject({ oauthAccount: { a: 1 }, hasCompletedOnboarding: true, projects: { '/other': { allowedTools: ['x'] }, '/w/a1': { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({ theme: 'light', env: { A: '1' }, skipDangerousModePermissionPrompt: true });
  });

  it('answers them on a fresh home too, in the dark theme a first run picks', () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-claude-'));
    acceptClaudeDialogs(home, '/w/a1');
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true });
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
