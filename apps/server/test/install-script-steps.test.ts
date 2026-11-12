import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER, SUB_A, install } from './install-script-helpers.js';

const STEPS = ['Step 1 of 4: Checking this computer', 'Step 2 of 4: Getting Hornhoof for this computer', 'Step 3 of 4: Connecting this computer', 'Step 4 of 4: Signing in'];
const CLAUDE_ONLY = `${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\\n`;
const CLOSE = 'You can close this window: the nodes keep running.';
/* Where each step starts in what the run said; -1 for one it did not show. */
const starts = (out: string, steps: string[]) => steps.map(step => out.indexOf(step));

describe('install.sh shows a person where it is', () => {
  it('walks a join through four numbered steps, each over its own work, and ends with what runs here and that the window may close', () => {
    const r = install({ env: { STUB_STATUS: 'after_login' } });
    expect(r.code).toBe(0);
    const at = starts(r.out, STEPS);
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const within = (text: string, step: number) => {
      const i = r.out.indexOf(text);
      expect(i).toBeGreaterThan(at[step]!);
      if (step + 1 < at.length) expect(i).toBeLessThan(at[step + 1]!);
    };
    within(`Checking that Hornhoof answers at ${SERVER}.`, 0);
    within('Checking Docker.', 0);
    within('Getting the node image', 1);
    within('Connecting this machine (test-box)', 2);
    within('Signing in to Claude', 3);
    const done = r.out.indexOf('Done. Hornhoof runs on this computer, test-box, with Claude and Codex.');
    expect(done).toBeGreaterThan(at[3]!);
    expect(r.out.indexOf(CLOSE)).toBeGreaterThan(done);
    expect(r.out).not.toContain('not ready yet');
  });

  it('says before the node image comes that it is a large download, and keeps colors and Docker progress out of output that is no terminal', () => {
    const r = install();
    expect(r.code).toBe(0);
    const said = r.out.indexOf('large download that can take 10 to 20 minutes on a slow connection');
    expect(said).toBeGreaterThan(r.out.indexOf(STEPS[1]!));
    expect(said).toBeLessThan(r.out.indexOf('Getting the node image'));
    expect(r.out).not.toContain('Pulling fs layer');
    expect(r.out).not.toMatch(/\x1b\[/);
  });

  it('numbers an update of the nodes the same way, and says when nothing needs a sign-in', () => {
    const r = install({ args: [], env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}` } });
    expect(r.code).toBe(0);
    const at = starts(r.out, [STEPS[0]!, STEPS[1]!, 'Step 3 of 4: Updating the nodes on this computer', STEPS[3]!]);
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(r.out.indexOf('Nothing needs a sign-in here.')).toBeGreaterThan(at[3]!);
    expect(r.out).toContain('Done. Hornhoof runs on this computer, test-box, with Claude.');
    expect(r.out).toContain(CLOSE);
  });

  it('names a computer without a plan as one for test runs', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_A} machine node-key-mmmmmmmmmmmmmmmm\\n` } });
    expect(r.code).toBe(0);
    expect(r.out.indexOf('Nothing needs a sign-in here.')).toBeGreaterThan(r.out.indexOf(STEPS[3]!));
    expect(r.out).toContain('Done. Hornhoof runs on this computer, test-box, for test runs.');
  });

  it('says in the last lines when a plan is not ready yet', () => {
    const r = install({ env: { STUB_JOIN_BODY: CLAUDE_ONLY, STUB_STATUS: 'needs_login', STUB_LOGIN_EXIT: '1' } });
    expect(r.code).toBe(0);
    const done = r.out.indexOf('Done. Hornhoof runs on this computer, test-box, with Claude.');
    expect(done).toBeGreaterThanOrEqual(0);
    expect(r.out.indexOf('Some of them are not ready yet: the list above says what to do.')).toBeGreaterThan(done);
  });

  it('numbers nothing for the updater, which no one watches, nor for a server install or a removal', () => {
    const updater = install({ args: [], env: { HORNHOOF_FROM_UPDATER: '1', STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}` } });
    expect(updater.code).toBe(0);
    expect(updater.out).toMatch(/Claude: ready/);
    const server = install({ args: ['server'], tty: '\n' });
    expect(server.code).toBe(0);
    const removal = install({ args: ['--uninstall'], tty: 'n\n', env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}` } });
    expect(removal.code).toBe(0);
    for (const r of [updater, server, removal]) {
      expect(r.out).not.toContain('Step ');
      expect(r.out).not.toContain('Done.');
      expect(r.out).not.toContain('Nothing needs a sign-in here.');
    }
  });
});

describe('install.sh before a sign-in in the terminal', () => {
  it.each([
    ['Linux', {}, 'To paste, press Ctrl+Shift+V in most Linux terminals.'],
    ['a Mac', { STUB_OS: 'Darwin', STUB_ARCH: 'arm64' }, 'To paste, press Cmd+V.'],
    ['Windows', { HORNHOOF_FROM_WINDOWS: '1' }, 'To paste in this window, right-click in it; if a menu shows, choose Paste. Ctrl+V does not paste here.'],
  ])('on %s says what to do in the browser, how to paste the code here, and to finish in one place only', (_, env, paste) => {
    const r = install({ env: { STUB_JOIN_BODY: CLAUDE_ONLY, STUB_STATUS: 'after_login', ...env } });
    expect(r.code).toBe(0);
    const box = r.out.slice(r.out.indexOf('Signing in to Claude on hornhoof-claude-1c07dac4'), r.out.indexOf('Logged in.'));
    expect(box).toContain('1. The sign-in page opens in your browser by itself. If it does not, open the link that shows below.');
    expect(box).toContain('2. Sign in there, and press Authorize.');
    expect(box).toContain('3. Copy the code the page shows.');
    expect(box).toContain(`4. Paste the code here and press Enter. ${paste}`);
    expect(box).toContain('You can also sign in once in Hornhoof under Subscriptions, for all your machines.');
    expect(box).toContain('This sign-in shows there too: finish it in one place only, here or there.');
  });

  it('keeps the steps general for a program that signs in its own way, and the Hornhoof hint for the plans Hornhoof signs in', () => {
    const google = install({ env: { STUB_JOIN_BODY: `${SUB_A} antigravity node-key-aaaaaaaaaaaaaaaa\\n` } });
    expect(google.code).toBe(0);
    expect(google.out).toContain('Signing in to Antigravity on');
    expect(google.out).toContain('2. Sign in there, and allow what it asks.');
    expect(google.out).toContain('3. Follow what this window shows below. When it asks for a code or a key, paste it here and press Enter. To paste, press Ctrl+Shift+V in most Linux terminals.');
    expect(google.out).not.toContain('Authorize');
    expect(google.out).not.toContain('under Subscriptions, for all your machines');
    expect(google.out).not.toContain('one place only');
    const codex = install({ env: { STUB_JOIN_BODY: `${SUB_A} codex node-key-bbbbbbbbbbbbbbbb\\n`, STUB_STATUS: 'after_login' } });
    expect(codex.out).toContain('Follow what this window shows below.');
    expect(codex.out).toContain('finish it in one place only');
  });
});

describe('install.sh in the container install.ps1 runs on Windows', () => {
  const fromWindows = (env: Record<string, string>) => {
    const file = join(mkdtempSync(join(tmpdir(), 'hh-link-')), 'open-url');
    const r = install({ env: { HORNHOOF_FROM_WINDOWS: '1', HORNHOOF_LINK_FILE: file, STUB_JOIN_BODY: CLAUDE_ONLY, STUB_STATUS: 'after_login', ...env } });
    return { ...r, file };
  };

  it('leaves the header of the Docker step to install.ps1, which did that step', () => {
    const r = fromWindows({});
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Step 1 of 4');
    expect(starts(r.out, STEPS.slice(1)).every(i => i >= 0)).toBe(true);
  });

  it('hands each sign-in link to install.ps1 through a file, which opens it in the browser of Windows', () => {
    const r = fromWindows({ STUB_LOGIN_URL: 'https://claude.ai/oauth/authorize?code=1', STUB_LOGIN_UNTIL_LOOKS: '2' });
    expect(r.code).toBe(0);
    expect(readFileSync(r.file, 'utf8')).toBe('https://claude.ai/oauth/authorize?code=1\n');
    expect(r.out).not.toContain('Open this link in a browser');
    expect(r.calls.filter(c => /^(xdg-)?open /.test(c))).toEqual([]);
  });

  it('hands over only a plain https link', () => {
    for (const link of ['file:///etc/passwd', 'https://claude.ai/x y']) {
      const r = fromWindows({ STUB_LOGIN_URL: link, STUB_LOGIN_UNTIL_LOOKS: '2' });
      expect(r.code).toBe(0);
      expect(existsSync(r.file)).toBe(false);
    }
  });
});
