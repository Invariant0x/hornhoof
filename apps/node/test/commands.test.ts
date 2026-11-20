import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { command } from '../src/main.js';
import { Outbox } from '../src/outbox.js';
import { markRemoved, readState } from '../src/state.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { testPort } from '../../../test-support/ports.mjs';
import { builtinKey } from '../src/keys.js';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (file: string, args: string[], options: import('node:child_process').SpawnOptions) =>
      original.spawn(file === 'npm' ? join(bin, 'npm') : file, args, options),
  };
});

/* A node's start checks Playwright's browsers; they are not the node's, so here they are ready at once. Preparing them for a
   repository keeps its own tests below and in browser.test.ts. */
vi.mock('../src/browser.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/browser.js')>();
  return { ...original, startupBrowserCheck: async () => null };
});

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const SERVER = 'https://hornhoof.example.test';
const KEY = 'node-key-0123456789abcdef';
const NODE_KEY = 'built-in-node-key-0123456789abcdef0123';
/* A turn's limit no test reaches: the node gives a turn a tenth more, at most 30 s, on a timer of at most 2_147_483_647 ms. */
const NO_TURN_LIMIT = 2_147_483_647 - 30_000;

let data: string;
let bin: string;
let logFile: string;

beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'hh-cmd-')));
  bin = join(data, 'tools', 'bin');
  logFile = join(data, 'fake.log');
  process.env.HORNHOOF_DATA = data;
  process.env.FAKE_LOG = logFile;
  delete process.env.FAKE_MODE;
  fakeNpm(true);
});

afterEach(() => {
  for (const k of ['HORNHOOF_DATA', 'FAKE_LOG', 'FAKE_MODE', 'FAKE_AGY_SETUP', 'HORNHOOF_SERVER', 'NODE_KEY', 'HORNHOOF_MACHINE_ID']) delete process.env[k];
});

function io(input = '') {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', c => (out += c));
  stderr.on('data', c => (err += c));
  if (input) stdin.end(input);
  return { io: { stdin, stdout, stderr }, out: () => out, err: () => err };
}

const run = async (args: string[], input = '') => {
  const t = io(input);
  const code = await command(args, t.io);
  return { code, out: t.out(), err: t.err() };
};

function installFake(name: string) {
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(FAKES, name), join(bin, name));
}

/* An npm that "installs" the fake program, or fails the way npm does. */
function fakeNpm(ok: boolean) {
  mkdirSync(bin, { recursive: true });
  const body = ok
    ? `printf '%s\\n' "$*" >> "$4/../npm.log"
case "$5" in
  @anthropic-ai/claude-code*) name=claude; package=@anthropic-ai/claude-code ;;
  @openai/codex*) name=codex; package=@openai/codex ;;
  @moonshot-ai/kimi-code*) name=kimi; package=@moonshot-ai/kimi-code ;;
  *) exit 78 ;;
esac
fixtures='${FAKES.replaceAll("'", "'\\''")}'
ln -sf "$fixtures$name" "$4/bin/$name"
mkdir -p "$4/lib/node_modules/$package"
printf '{"version":"2.0.0"}' > "$4/lib/node_modules/$package/package.json"
id -u > "$4/../npm.uid.tmp"
mv "$4/../npm.uid.tmp" "$4/../npm.uid"
`
    : `echo "npm error 404 Not Found" >&2\nexit 1\n`;
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, 'npm'), 0o755);
}

const logged = () => readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.argv);

/* A Hornhoof that records what a node says and sends it what the test gives. */
async function fakeServer() {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: { type: string; [k: string]: unknown }[] = [];
  const headers: string[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', (s, req) => {
    socket = s;
    headers.push(req.headers.authorization ?? '');
    s.on('message', d => received.push(JSON.parse(String(d))));
  });
  const wait = (check: () => boolean) => eventually(check);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, headers, send: (m: object) => socket!.send(JSON.stringify(m)), wait };
}

describe('set-server', () => {
  const FRONT = 'http://host.docker.internal:8081';

  it('moves the node to another address of its server and keeps who it is', async () => {
    await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
    new Outbox(data).add({ type: 'removed' });
    const res = await run(['set-server'], `${FRONT}\n`);
    expect(res.code).toBe(0);
    expect(readState(data)).toEqual({ server: FRONT, subscriptionId: 'sub-1', provider: 'claude', key: KEY });
    expect(statSync(join(data, 'node.json')).mode & 0o777).toBe(0o600);
    /* It is the same node of the same company, so what it still has to say is still its own. */
    expect(new Outbox(data).pending().map(entry => entry.msg.type)).toEqual(['removed']);
  });

  it('keeps a machine node a machine node', async () => {
    await run(['set-key'], `${SERVER} node-1 machine ${KEY}\n`);
    expect((await run(['set-server'], `${FRONT}\n`)).code).toBe(0);
    expect(readState(data)).toEqual({ server: FRONT, subscriptionId: 'node-1', provider: null, key: KEY });
  });

  it('refuses a line that is no address, and a node that was never set up', async () => {
    const none = await run(['set-server'], `${FRONT}\n`);
    expect(none.code).toBe(1);
    expect(none.err).toContain('set-server expects one line: <server>');
    expect(existsSync(join(data, 'node.json'))).toBe(false);
    await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
    for (const line of ['', 'front:8080', 'ftp://front', `${FRONT} extra`]) {
      const res = await run(['set-server'], `${line}\n`);
      expect(res.code, line).toBe(1);
      expect(res.err).toContain('set-server expects one line: <server>');
    }
    expect(readState(data)!.server).toBe(SERVER);
  });
});

describe('set-key', () => {
  it('saves the line from the installer as a private state file', async () => {
    const res = await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
    expect(res.code).toBe(0);
    expect(readState(data)).toEqual({ server: SERVER, subscriptionId: 'sub-1', provider: 'claude', key: KEY });
    expect(statSync(join(data, 'node.json')).mode & 0o777).toBe(0o600);
  });

  it('takes the key of a machine without a plan', async () => {
    expect((await run(['set-key'], `${SERVER} node-1 machine ${KEY}\n`)).code).toBe(0);
    expect(readState(data)).toEqual({ server: SERVER, subscriptionId: 'node-1', provider: null, key: KEY });
  });

  it('refuses a line it cannot read and writes nothing', async () => {
    const res = await run(['set-key'], `${SERVER} sub-1 notaprovider ${KEY}\n`);
    expect(res.code).toBe(1);
    expect(res.err).toContain('<server> <id> <provider or machine> <key>');
    expect(existsSync(join(data, 'node.json'))).toBe(false);
  });

  it('brings a removed node back with its new key', async () => {
    markRemoved(data);
    await run(['set-key'], `${SERVER} sub-2 claude ${KEY}\n`);
    expect((await run(['status'])).out.trim()).not.toBe('removed');
  });

  describe('and what waits in the outbox', () => {
    const NEW_KEY = 'node-key-new-0123456789abcdef';
    const kept = () => new Outbox(data).pending().map(entry => entry.msg.type);
    /* A node set up on this server and plan, with a removed it could not get confirmed. */
    const owingRemoved = async () => {
      await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
      new Outbox(data).add({ type: 'removed' });
    };

    it('forgets it when a removed node comes back, so an old removed cannot revoke the new key', async () => {
      await owingRemoved();
      markRemoved(data);
      await run(['set-key'], `${SERVER} sub-1 claude ${NEW_KEY}\n`);
      expect(kept()).toEqual([]);
    });

    it.each([
      ['another server', `https://other.example.test sub-1 claude ${NEW_KEY}\n`],
      ['another subscription', `${SERVER} sub-2 claude ${NEW_KEY}\n`],
    ])('forgets it when the node moves to %s', async (_, line) => {
      await owingRemoved();
      await run(['set-key'], line);
      expect(kept()).toEqual([]);
    });

    it('forgets it when nothing says whose it was', async () => {
      new Outbox(data).add({ type: 'removed' });
      await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
      expect(kept()).toEqual([]);
    });

    it('keeps it when only the key changes', async () => {
      await owingRemoved();
      await run(['set-key'], `${SERVER} sub-1 claude ${NEW_KEY}\n`);
      expect(kept()).toEqual(['removed']);
    });

    it('keeps it when the line is refused', async () => {
      await owingRemoved();
      expect((await run(['set-key'], `${SERVER} sub-2 claude ${NEW_KEY} extra\n`)).code).toBe(1);
      expect(kept()).toEqual(['removed']);
    });
  });
});

describe('status', () => {
  it('tells no_key, needs_login, ready and removed apart', async () => {
    expect((await run(['status'])).out).toBe('no_key\n');

    await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
    installFake('claude');
    process.env.FAKE_MODE = 'signed_out';
    expect((await run(['status'])).out).toBe('needs_login\n');

    delete process.env.FAKE_MODE;
    expect((await run(['status'])).out).toBe('ready\n');
    expect(logged().at(-1)).toMatchObject({ argv: ['auth', 'status'], env: { CLAUDE_CONFIG_DIR: join(data, 'home') } });

    markRemoved(data);
    expect((await run(['status'])).out).toBe('removed\n');
  });

  it('has nothing to sign in to on a machine without a plan', async () => {
    await run(['set-key'], `${SERVER} node-1 machine ${KEY}\n`);
    expect((await run(['status'])).out).toBe('ready\n');
    fakeNpm(true);
    expect(await run(['login'])).toMatchObject({ code: 0, out: 'This machine has no plan to sign in to.\n' });
    expect(existsSync(join(data, 'npm.log'))).toBe(false);
  });

  it('counts a missing agent program as not signed in', async () => {
    await run(['set-key'], `${SERVER} sub-1 codex ${KEY}\n`);
    expect((await run(['status'])).out).toBe('needs_login\n');
  });
});

/* The steps a sign-in in the install window left for the running node. */
const stepsLeft = () => readFileSync(join(data, 'login-steps'), 'utf8').trim().split('\n').map(l => { const entry = JSON.parse(l) as Record<string, unknown>; delete entry.run; return entry; });

describe('login', () => {
  beforeEach(async () => {
    await run(['set-key'], `${SERVER} sub-1 claude ${KEY}\n`);
  });

  it('installs the program, signs in and leaves the link for the installer', async () => {
    fakeNpm(true);
    process.env.FAKE_MODE = 'needs_login';
    const t = io();
    expect(await command(['login'], t.io)).toBe(0);
    expect(readFileSync(join(data, 'npm.log'), 'utf8')).toContain(`install -g --prefix ${join(data, 'tools')} @anthropic-ai/claude-code`);
    expect(logged().map(l => l.argv.join(' '))).toContain('auth login');
    expect(readFileSync(join(data, 'login-url'), 'utf8')).toBe('https://login.example.test/device?code=ABC\n');
    expect(t.out()).toContain('Installing Claude Code.');
    expect(t.out()).toContain('Logged in.');
  });

  it('tells the running node each step after the code: checking the sign-in, then signed in', async () => {
    fakeNpm(true);
    process.env.FAKE_MODE = 'needs_login';
    /* What an earlier sign-in left goes. */
    writeFileSync(join(data, 'login-steps'), '{"step":"models"}\n');
    expect(await command(['login'], io().io)).toBe(0);
    expect(stepsLeft()).toEqual([{ step: 'checking' }, { step: 'signed_in' }]);
  });

  it('tells the running node why a sign-in its program did not take failed', async () => {
    installFake('claude');
    process.env.FAKE_MODE = 'signed_out';
    expect((await run(['login'])).code).toBe(1);
    expect(stepsLeft()).toEqual([{ step: 'checking' }, { step: 'failed', error: 'The program did not take the new sign-in, so nothing changed.', line: null }]);
  });

  it('skips the sign-in when the program is already signed in', async () => {
    installFake('claude');
    const res = await run(['login']);
    expect(res).toMatchObject({ code: 0, out: expect.stringContaining('Logged in.') });
    expect(logged().map(l => l.argv.join(' '))).not.toContain('auth login');
  });

  it('says why when the program cannot be installed', async () => {
    fakeNpm(false);
    const res = await run(['login']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('Could not install Claude Code');
    expect(res.err).toContain('404');
  });

  it('fails when the person is still signed out afterwards', async () => {
    installFake('claude');
    process.env.FAKE_MODE = 'signed_out';
    const res = await run(['login']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('not signed in');
  });

  it('needs a key first', async () => {
    process.env.HORNHOOF_DATA = mkdtempSync(join(tmpdir(), 'hh-empty-'));
    const res = await run(['login']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('install command');
  });
});

/* agy asks a person who signed it in on a machine to accept its terms once there, which only the plan's owner may do. */
describe("a plan whose program asks for a first setup on its machine", () => {
  const settings = () => join(data, 'home', '.gemini', 'antigravity-cli', 'settings.json');
  /* What a person's Done leaves: agy 1.4.12 kept its settings as {}, and the fake agy keeps the rest in its own file. */
  const passed = () => {
    mkdirSync(dirname(settings()), { recursive: true });
    writeFileSync(settings(), '{}\n');
    writeFileSync(join(data, 'agy-setup-passed'), '');
  };
  beforeEach(async () => {
    process.env.FAKE_AGY_SETUP = join(data, 'agy-setup-passed');
    await run(['set-key'], `${SERVER} sub-1 antigravity ${KEY}\n`);
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(FAKES, 'fake-agy-term.mjs'), join(bin, 'agy'));
    mkdirSync(join(data, 'home'), { recursive: true });
    writeFileSync(join(data, 'home', 'fake-signed-in'), '');
  });

  it('says needs_setup while agy shows its first-run setup, and ready once it shows its prompt with settings of {}', async () => {
    expect((await run(['status'])).out).toBe('needs_setup\n');
    passed();
    expect((await run(['status'])).out).toBe('ready\n');
  });

  it('goes with the sign-in, which says why it cannot finish without the terminal of the person who runs it', async () => {
    const res = await run(['login']);
    expect(res.code).toBe(1);
    expect(res.err).toBe('The first setup of Antigravity CLI did not finish: Its terms need the terminal of the person who runs the install command.\n');
    expect(existsSync(settings())).toBe(false);
    expect((await run(['status'])).out).toBe('needs_setup\n');
  });

  it('is left out of the sign-in once passed', async () => {
    passed();
    expect(await run(['login'])).toMatchObject({ code: 0, out: 'Logged in.\n' });
  });

  /* As the node does not hold a plan for a setup it cannot see, while the sign-in says why it cannot finish it. */
  it('says ready when the node cannot look at agy, and the sign-in says why its first setup did not finish', async () => {
    writeFileSync(join(data, 'home', '.hh-setup-check'), '');
    expect(await run(['status'])).toMatchObject({ code: 0, out: 'ready\n' });
    const res = await run(['login']);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/^The first setup of Antigravity CLI did not finish: EEXIST: file already exists, mkdir '.+\.hh-setup-check'\n$/);
  });
});

describe('run --builtin', () => {
  it('needs the server address and the key in its env', async () => {
    const res = await run(['run', '--builtin']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('HORNHOOF_SERVER');
  });

  it('signs in with the key of its machine when the machine has an id', async () => {
    const server = await fakeServer();
    const machine = 'a1b2c3d4'.repeat(4);
    process.env.HORNHOOF_SERVER = server.url;
    process.env.NODE_KEY = NODE_KEY;
    process.env.HORNHOOF_MACHINE_ID = machine;
    const node = await command(['run', '--builtin'], io().io);
    if (typeof node === 'number') throw new Error(`run ended with ${node}`);
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.headers[0]).toBe(`Bearer ${builtinKey(NODE_KEY, machine)}`);
    expect(server.headers[0]).toMatch(/^Bearer builtin\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  });

  it('runs each API key job with its own home and key, and ignores remove', async () => {
    const server = await fakeServer();
    process.env.HORNHOOF_SERVER = server.url;
    process.env.NODE_KEY = NODE_KEY;
    installFake('claude');
    installFake('codex');
    const node = await command(['run', '--builtin'], io().io);
    if (typeof node === 'number') throw new Error(`run ended with ${node}`);
    onTestFinished(() => node.stop());

    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.headers[0]).toBe(`Bearer ${NODE_KEY}`);
    expect(server.received[0]).toMatchObject({ loggedIn: true, running: [] });

    const job = { subscriptionId: 'sub-a', sessionId: null, model: null, timeoutMs: NO_TURN_LIMIT, prompt: 'say ready', instructions: null, toolToken: null };
    server.send({ type: 'job.run', jobId: 'j1', provider: 'anthropic_api', secret: 'company-anthropic-key-000000', ...job });
    server.send({ type: 'job.run', jobId: 'j2', provider: 'openai_api', secret: 'company-openai-key-0000000000', ...job, subscriptionId: 'sub-b' });
    await server.wait(() => server.received.filter(m => m.type === 'job.done').length === 2);
    expect(server.received.filter(m => m.type === 'job.done')).toEqual(
      expect.arrayContaining([expect.objectContaining({ jobId: 'j1', ok: true, result: 'ready' }), expect.objectContaining({ jobId: 'j2', ok: true, result: 'ready' })]),
    );
    const [claude, codex] = [logged().find(l => l.name === 'claude'), logged().find(l => l.name === 'codex')];
    expect(claude.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(data, 'subs', 'sub-a'), ANTHROPIC_API_KEY: 'company-anthropic-key-000000' });
    expect(codex.env).toMatchObject({ CODEX_HOME: join(data, 'subs', 'sub-b'), CODEX_API_KEY: 'company-openai-key-0000000000' });
    expect(claude.env).not.toHaveProperty('NODE_KEY');
    expect(readFileSync(join(data, 'npm.log'), 'utf8').trim().split('\n')).toEqual([
      `install -g --prefix ${join(data, 'tools')} @anthropic-ai/claude-code@latest`,
      `install -g --prefix ${join(data, 'tools')} @openai/codex@latest`,
    ]);

    server.send({ type: 'remove' });
    /* A node that took the remove runs no turn after it: one that ends proves the remove was handled and left alone. */
    server.send({ type: 'job.run', jobId: 'j3', provider: 'anthropic_api', secret: 'company-anthropic-key-000000', ...job });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j3'));
    expect(server.received.some(m => m.type === 'removed')).toBe(false);
    expect(existsSync(join(data, 'removed'))).toBe(false);
  });
});

describe('program updates at node startup', () => {
  it.each([
    ['claude', '@anthropic-ai/claude-code'],
    ['codex', '@openai/codex'],
    ['kimi', '@moonshot-ai/kimi-code'],
  ])('updates an already-installed %s as the tools owner', async (provider, packageName) => {
    const server = await fakeServer();
    await run(['set-key'], `${server.url} sub-1 ${provider} ${KEY}\n`);
    installFake(provider);
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const node = await command(['run'], io().io);
    if (typeof node === 'number') throw new Error(`run ended with ${node}`);
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    await server.wait(() => existsSync(join(data, 'npm.uid')));
    expect(readFileSync(join(data, 'npm.log'), 'utf8').trim()).toBe(`install -g --prefix ${join(data, 'tools')} ${packageName}@latest`);
    expect(Number(readFileSync(join(data, 'npm.uid'), 'utf8').trim())).toBe(statSync(join(data, 'tools')).uid);
    expect(JSON.parse(readFileSync(join(data, 'tools', 'lib', 'node_modules', packageName, 'package.json'), 'utf8'))).toEqual({ version: '2.0.0' });
  });
});

describe('run on a machine without a plan', () => {
  it('connects with its key as signed in, installs no agent program and runs no turn', async () => {
    const server = await fakeServer();
    await run(['set-key'], `${server.url} node-1 machine ${KEY}\n`);
    fakeNpm(true);
    const node = await command(['run'], io().io);
    if (typeof node === 'number') throw new Error(`run ended with ${node}`);
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.headers[0]).toBe(`Bearer ${KEY}`);
    expect(server.received[0]).toMatchObject({ type: 'hello', loggedIn: true, running: [], terminals: false });
    server.send({ type: 'job.run', jobId: 'j1', provider: 'claude', secret: null, subscriptionId: 'sub-a', sessionId: null, model: null, timeoutMs: NO_TURN_LIMIT, prompt: 'hi', instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'j1', ok: false, error: 'agent_failed', tail: expect.stringContaining('no plan') });
    expect(existsSync(join(data, 'npm.log'))).toBe(false);
  });
});

describe('unknown commands', () => {
  it('lists the commands', async () => {
    const res = await run(['dance']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('run [--builtin]');
  });
});

describe('browser status and prepare-browser command', () => {
  it('reports browser_failed with the named cause in status when browser-error is present', async () => {
    await run(['set-key'], `${SERVER} node-1 machine ${KEY}\n`);
    expect((await run(['status'])).out.trim()).toBe('ready');
    writeFileSync(join(data, 'browser-error'), 'libnss3.so: cannot open shared object file\n');
    expect((await run(['status'])).out.trim()).toBe('browser_failed: libnss3.so: cannot open shared object file');
  });

  it('skips non-Playwright repositories cleanly in prepare-browser and exits 1 when preparation fails', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'hh-cmd-repo-'));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/vitest': { version: '5.0.5' } } }));
    const res = await run(['prepare-browser', repo]);
    expect(res.code).toBe(0);
    expect(res.out.trim()).toBe('not_needed');

    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '99.99.99' } } }));
    vi.stubEnv('PATH', '/nonexistent-hh-bin');
    const failed = await run(['prepare-browser', repo]);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('Playwright browsers could not start:');
  });
});
