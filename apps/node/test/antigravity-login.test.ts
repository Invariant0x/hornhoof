import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityAdapter } from '../src/providers/antigravity.js';

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
