import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityAdapter, agySettings, ownTerminal, SETUP_PASSED, type Person } from '../src/providers/antigravity.js';
import type { Tmux } from '../src/terminal/tmux.js';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

const FAKE = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));

const until = async (check: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (check()) return;
  throw new Error('timed out');
};

/* agy signs in only from its own screen, so the node answers that screen in tmux for the person. */
function signIn() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-login-'));
  const output = new PassThrough();
  let printed = '';
  output.on('data', c => (printed += c));
  const input = new PassThrough();
  const urlFile = join(dir, 'login-url');
  const adapter = antigravityAdapter({ home: join(dir, 'home'), tools: join(dir, 'tools'), bin: FAKE });
  const done = adapter.login({ input, output, urlFile });
  done.catch(() => {});
  return { adapter, done, input, urlFile, printed: () => printed };
}

describe.skipIf(!hasTmux)('Antigravity CLI sign-in', () => {
  it('picks Google on its screen, saves the whole link and types the code the person pastes', async () => {
    const s = signIn();
    await until(() => existsSync(s.urlFile));
    const url = readFileSync(s.urlFile, 'utf8').trim();
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+&state=FAKE-state$/);
    expect(s.printed()).toContain(url);
    expect(await s.adapter.loggedIn()).toBe(false);

    s.input.write('good-code\n');
    await s.done;
    expect(await s.adapter.loggedIn()).toBe(true);
    /* The hidden screen is gone. */
    expect(() => execFileSync('tmux', ['-L', 'hh-login', 'list-sessions'], { stdio: 'ignore' })).toThrow();
  });

  it("stops with Google's answer when the code is wrong", async () => {
    const s = signIn();
    await until(() => existsSync(s.urlFile));
    s.input.write('wrong-code\n');
    await expect(s.done).rejects.toThrow(/invalid_grant/);
    expect(await s.adapter.loggedIn()).toBe(false);
  });

  it('stops when the person pastes nothing', async () => {
    const s = signIn();
    await until(() => existsSync(s.urlFile));
    s.input.end();
    await expect(s.done).rejects.toThrow(/No code/);
  });
});

describe("Antigravity CLI's first-run setup", () => {
  it('is read from the settings agy keeps in the plan\'s home, which the node never writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-settings-'));
    const home = join(dir, 'home');
    const adapter = antigravityAdapter({ home, tools: join(dir, 'tools'), bin: FAKE });
    /* A new machine has no settings at all. */
    expect(await adapter.setupNeeded!()).toBe(true);
    const file = agySettings(home);
    expect(file).toBe(join(home, '.gemini', 'antigravity-cli', 'settings.json'));
    mkdirSync(dirname(file), { recursive: true });
    /* What the node reads as passed, among other settings, and that mark with each of its parts missing or written as text. */
    const passed = JSON.stringify({ colorScheme: 'dark', ...SETUP_PASSED });
    const short = Object.entries(SETUP_PASSED).flatMap(([key, value]) => [{ ...SETUP_PASSED, [key]: undefined }, { ...SETUP_PASSED, [key]: JSON.stringify(value) }]);
    /* An empty mark would count any settings as passed. */
    expect(Object.keys(SETUP_PASSED)).not.toEqual([]);
    for (const [settings, needed] of [['{"colorScheme":"dark"}', true], ['{ not json', true], ...short.map(s => [JSON.stringify(s), true] as const), [passed, false]] as const) {
      writeFileSync(file, settings);
      expect(await adapter.setupNeeded!()).toBe(needed);
      expect(readFileSync(file, 'utf8')).toBe(settings);
    }
    /* An agent owns that home and could link the file elsewhere; a link is not read. */
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify(SETUP_PASSED));
    rmSync(file);
    symlinkSync(other, file);
    expect(await adapter.setupNeeded!()).toBe(true);
  });
});

it("shows agy's terms only on the terminal of the person who runs the install command", () => {
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  expect(ownTerminal(tty, tty)).toBe(true);
  expect(ownTerminal(new PassThrough(), tty)).toBe(false);
  const pipe = new PassThrough();
  expect(ownTerminal(pipe, pipe)).toBe(false);
});

describe.skipIf(!hasTmux)("Antigravity CLI's first-run setup on the owner's terminal", () => {
  /* agy signed in on a machine where nobody passed its setup, and the person who runs the install command there. */
  function setUp(answer: ReturnType<Person>) {
    const dir = mkdtempSync(join(tmpdir(), 'agy-setup-'));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'fake-signed-in'), '');
    const log = join(dir, 'agy.log');
    process.env.FAKE_LOG = log;
    process.env.FAKE_AGY_SETUP = JSON.stringify(SETUP_PASSED);
    const output = new PassThrough();
    let printed = '';
    output.on('data', c => (printed += c));
    const adapter = antigravityAdapter({ home, tools: join(dir, 'tools'), bin: FAKE, person: () => answer });
    const keys = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.setup);
    return { adapter, home, keys, printed: () => printed, done: adapter.setup!({ input: new PassThrough(), output, urlFile: join(dir, 'login-url') }) };
  }
  const gone = async (tmux: Tmux, session: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end && (await tmux.alive(session)); ) await new Promise(r => setTimeout(r, 50));
  };

  it('takes the colors itself and leaves the terms to the person on agy\'s own screen, until agy saved them', async () => {
    let shown = '';
    const s = setUp(async (tmux, session) => {
      shown = await tmux.screen(session, 0);
      for (const key of ['Down', 'Down', 'Enter']) await tmux.keys(session, key);
      await gone(tmux, session);
    });
    await s.done;
    expect(shown).toContain('Terms of Service & Data Use');
    expect(s.printed()).toContain('terms of service');
    expect(s.keys()).toEqual([{ setup: 'colors', key: 'enter' }, { setup: 'terms', key: 'down' }, { setup: 'terms', key: 'down' }, { setup: 'terms', key: 'enter' }]);
    expect(JSON.parse(readFileSync(agySettings(s.home), 'utf8'))).toEqual(SETUP_PASSED);
    expect(await s.adapter.setupNeeded!()).toBe(false);
    /* The hidden screen is gone. */
    expect(() => execFileSync('tmux', ['-L', 'hh-login', 'list-sessions'], { stdio: 'ignore' })).toThrow();
  });

  it('stops saying so when the person closes agy on its terms', async () => {
    const s = setUp(async (tmux, session) => {
      for (const key of ['C-c', 'C-c']) await tmux.keys(session, key);
      await gone(tmux, session);
    });
    await expect(s.done).rejects.toThrow(/closed before its terms were accepted/);
    expect(s.keys()).toEqual([{ setup: 'colors', key: 'enter' }, { setup: 'terms', key: 'ctrl-c' }, { setup: 'terms', key: 'ctrl-c' }]);
    expect(await s.adapter.setupNeeded!()).toBe(true);
  });

  it("stops, and closes agy, when the person's terminal is gone while agy still shows its terms", async () => {
    const s = setUp(async () => {});
    await expect(s.done).rejects.toThrow(/before its terms were accepted/);
    expect(s.keys()).toEqual([{ setup: 'colors', key: 'enter' }]);
    expect(await s.adapter.setupNeeded!()).toBe(true);
    expect(() => execFileSync('tmux', ['-L', 'hh-login', 'list-sessions'], { stdio: 'ignore' })).toThrow();
  });
});
