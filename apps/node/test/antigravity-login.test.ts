import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { antigravityAdapter, ownTerminal, SETUP_LOOK_MS, type Person } from '../src/providers/antigravity.js';
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

const settingsOf = (home: string) => join(home, '.gemini', 'antigravity-cli', 'settings.json');
const keysIn = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.setup) : []);
/* What runs to look at agy's setup in this folder: its tmux server and agy, none once the look is over. */
const lookingIn = (dir: string) => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(join(dir, 'home', '.hh-setup-check')));
const goneFrom = async (dir: string) => {
  await until(() => lookingIn(dir).length === 0, 5000).catch(() => {});
  return lookingIn(dir);
};

describe.skipIf(!hasTmux)("Antigravity CLI's first-run setup", () => {
  it("is read from agy's screen as a turn starts it, never from its settings, and the node presses nothing there", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-look-'));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const log = join(dir, 'agy.log');
    process.env.FAKE_LOG = log;
    process.env.FAKE_AGY_SETUP = join(dir, 'passed');
    const adapter = antigravityAdapter({ home, tools: join(dir, 'tools'), bin: FAKE });
    /* A new machine, where agy shows its setup. */
    expect(await adapter.setupNeeded!()).toBe(true);
    /* Its settings do not count, even with a mark that would skip the setup. */
    mkdirSync(dirname(settingsOf(home)), { recursive: true });
    writeFileSync(settingsOf(home), JSON.stringify({ consumerOnboardingComplete: true }));
    expect(await adapter.setupNeeded!()).toBe(true);
    /* Once a person passed it, as on a machine where agy 1.4.12 left its settings as {}, agy shows its prompt. */
    writeFileSync(settingsOf(home), '{}\n');
    writeFileSync(join(dir, 'passed'), '');
    expect(await adapter.setupNeeded!()).toBe(false);
    expect(readFileSync(settingsOf(home), 'utf8')).toBe('{}\n');
    /* It started agy as a turn does, in a folder it trusts, so agy asks nothing else there. */
    const started = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(r => r.argv);
    expect(started.argv).toEqual(['--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: [join(home, '.hh-setup-check')] })]);
    /* No key reached agy, and nothing it started is left. */
    expect(keysIn(log)).toEqual([]);
    expect(await goneFrom(dir)).toEqual([]);
  });

  it('is not held for an agy that shows neither its setup nor its prompt in time, nor for one that ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-look-'));
    const silent = join(dir, 'silent.sh');
    writeFileSync(silent, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    const ends = join(dir, 'ends.sh');
    writeFileSync(ends, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const startedAt = Date.now();
    expect(await antigravityAdapter({ home: join(dir, 'home'), tools: join(dir, 'tools'), bin: ends }).setupNeeded!()).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let found: boolean | undefined;
      void antigravityAdapter({ home: join(dir, 'home'), tools: join(dir, 'tools'), bin: silent }).setupNeeded!().then(f => (found = f));
      await until(() => lookingIn(dir).some(line => line.includes('silent.sh')));
      await new Promise(r => setTimeout(r, 1000));
      /* Still looking, until its time is up. */
      expect(found).toBeUndefined();
      while (found === undefined) {
        vi.setSystemTime(Date.now() + SETUP_LOOK_MS);
        await new Promise(r => setTimeout(r, 100));
      }
      expect(found).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await goneFrom(dir)).toEqual([]);
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
  function setUp(answer: ReturnType<Person>, passedBefore = false) {
    const dir = mkdtempSync(join(tmpdir(), 'agy-setup-'));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'fake-signed-in'), '');
    const log = join(dir, 'agy.log');
    const passed = join(dir, 'passed');
    if (passedBefore) writeFileSync(passed, '');
    process.env.FAKE_LOG = log;
    process.env.FAKE_AGY_SETUP = passed;
    const output = new PassThrough();
    let printed = '';
    output.on('data', c => (printed += c));
    const adapter = antigravityAdapter({ home, tools: join(dir, 'tools'), bin: FAKE, person: () => answer });
    return { adapter, home, passed, keys: () => keysIn(log), printed: () => printed, done: adapter.setup!({ input: new PassThrough(), output, urlFile: join(dir, 'login-url') }) };
  }
  const gone = async (tmux: Tmux, session: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end && (await tmux.alive(session)); ) await new Promise(r => setTimeout(r, 50));
  };

  it('takes the colors itself and leaves the terms to the person on agy\'s own screen, until agy shows its prompt', async () => {
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
    expect(existsSync(s.passed)).toBe(true);
    expect(readFileSync(settingsOf(s.home), 'utf8')).toBe('{}\n');
    expect(await s.adapter.setupNeeded!()).toBe(false);
    /* The hidden screen is gone. */
    expect(() => execFileSync('tmux', ['-L', 'hh-login', 'list-sessions'], { stdio: 'ignore' })).toThrow();
  });

  /* Someone passed it between the node's look and this start. */
  it('asks nothing of the person when agy comes to its prompt', async () => {
    let asked = false;
    const s = setUp(async () => { asked = true; }, true);
    await s.done;
    expect([asked, s.printed(), s.keys()]).toEqual([false, '', []]);
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
