import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentUser, ensurePasswd, FIRST_UID, prepareFolder, secureNode, userFor, type FolderOps } from '../src/isolation.js';
import { builtinAdapters } from '../src/providers/index.js';
import { claudeAdapter } from '../src/providers/claude.js';
import { codexAdapter } from '../src/providers/codex.js';
import { kimiAdapter } from '../src/providers/kimi.js';
import { exitsCleanly, installPackage, interactiveLogin, runProgram } from '../src/providers/process.js';
import { PassThrough } from 'node:stream';

const tmp = () => mkdtempSync(join(tmpdir(), 'hh-iso-'));

/* What each program was started as. A program asked to run as another user than this test's gets the system's answer to a
   node that is not root, recorded: the system refuses. */
const started = vi.hoisted(() => [] as { file: string; uid?: number; gid?: number }[]);
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (file: string, args: string[], options: import('node:child_process').SpawnOptions) => {
      started.push({ file, uid: options.uid, gid: options.gid });
      if (options.uid !== undefined && options.uid !== process.getuid?.()) throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM', syscall: 'spawn' });
      return original.spawn(file === 'npm' ? join(args[args.indexOf('--prefix') + 1]!, 'bin', 'npm') : file, args, options);
    },
  };
});

function fakeOps(owners: Record<string, number> = {}, missing: string[] = []) {
  const calls: string[] = [];
  const ops: FolderOps = {
    mkdir: path => void calls.push(`mkdir ${path}`),
    exists: path => !missing.includes(path),
    owner: path => owners[path] ?? 0,
    chown: (path, uid, gid) => void calls.push(`chown1 ${path} ${uid}:${gid}`),
    chownTree: (path, uid, gid) => void calls.push(`chown ${path} ${uid}:${gid}`),
    chmod: (path, mode) => void calls.push(`chmod ${path} ${mode.toString(8)}`),
  };
  return { ops, calls };
}

describe('userFor', () => {
  it('gives each subscription its own user from 20000, the same one after a restart', () => {
    const dir = tmp();
    expect(FIRST_UID).toBe(20000);
    expect(userFor(dir, 'sub-a', true)).toEqual({ uid: 20000, gid: 20000 });
    expect(userFor(dir, 'sub-b', true)).toEqual({ uid: 20001, gid: 20001 });
    expect(userFor(dir, 'sub-a', true)).toEqual({ uid: 20000, gid: 20000 });
    expect(JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'))).toEqual({ 'sub-a': 20000, 'sub-b': 20001 });
    expect(statSync(join(dir, 'users.json')).mode & 0o777).toBe(0o600);
  });

  it('gives no user when the node does not run as root', () => {
    expect(userFor(tmp(), 'sub-a', false)).toBeNull();
  });
});

describe('agentUser', () => {
  /* CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID and SYS_PTRACE. */
  const ALL = 0x800eb;
  function system(uid: number, caps: number, passwd = 'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n') {
    const dir = tmp();
    writeFileSync(join(dir, 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapEff:\t${caps.toString(16).padStart(16, '0')}\n`);
    writeFileSync(join(dir, 'passwd'), passwd);
    return { status: join(dir, 'status'), passwd: join(dir, 'passwd') };
  }

  it("runs a root node's agents as the image's node user, when root may hand them over and check their calls", () => {
    expect(agentUser(system(0, ALL))).toEqual({ uid: 1000, gid: 1000 });
    expect(agentUser(system(0, 0x1ffffffffff))).toEqual({ uid: 1000, gid: 1000 });
  });

  it('keeps agents as the node itself when it is not root, lacks a power for that, or has no node user', () => {
    expect(agentUser(system(1000, ALL))).toBeNull();
    expect(agentUser(system(0, ALL & ~(1 << 19)))).toBeNull();
    expect(agentUser(system(0, ALL & ~(1 << 7)))).toBeNull();
    expect(agentUser(system(0, ALL, 'root:x:0:0:root:/root:/bin/bash\n'))).toBeNull();
  });
});

describe('secureNode', () => {
  it("keeps the node's own files and programs to root and gives the agents their homes and work folders", () => {
    const user = { uid: 1000, gid: 1000 };
    const { ops, calls } = fakeOps({ '/data': 1000, '/data/node.json': 1000, '/data/tools': 1000, '/data/sessions.json': 0, '/data/home': 1000 }, ['/data/users.json', '/data/login-url', '/data/removed', '/data/.hh-recordings', '/data/browsers']);
    secureNode('/data', user, ops);
    expect(calls).toEqual([
      'chown1 /data 0:0',
      'chmod /data 755',
      'chown1 /data/node.json 0:0',
      'chown /data/tools 0:0',
      'mkdir /data/home',
      'chmod /data/home 700',
      'mkdir /data/work',
      'chown /data/work 1000:1000',
      'chmod /data/work 700',
    ]);

    const { ops: ops2, calls: calls2 } = fakeOps(
      { '/data': 0, '/data/browser-error': 1000, '/data/home': 1000, '/data/work': 1000 },
      ['/data/node.json', '/data/sessions.json', '/data/users.json', '/data/login-url', '/data/removed', '/data/tools', '/data/.hh-recordings', '/data/browsers'],
    );
    secureNode('/data', user, ops2);
    expect(calls2).toContain('chown1 /data/browser-error 0:0');
  });

  it('takes back only the top of the shared browsers from an agent or a test run that held them: what they left in it must still read as theirs when the node looks at it', () => {
    const user = { uid: 1000, gid: 1000 };
    const held = fakeOps({ '/data/browsers': 20000 });
    secureNode('/data', user, held.ops);
    expect(held.calls.filter(call => call.includes('browsers'))).toEqual(['chown1 /data/browsers 0:0']);

    const roots = fakeOps({ '/data/browsers': 0 });
    secureNode('/data', user, roots.ops);
    expect(roots.calls.filter(call => call.includes('browsers'))).toEqual([]);
  });
});

describe('secureNode and the outbox', () => {
  it('makes outbox.jsonl root-owned when it exists, and leaves it alone when it does not', () => {
    const user = { uid: 1000, gid: 1000 };
    const missing = ['/data/node.json', '/data/sessions.json', '/data/users.json', '/data/login-url', '/data/removed', '/data/tools', '/data/.hh-recordings'];
    const owned = fakeOps({ '/data/outbox.jsonl': 1000 }, missing);
    secureNode('/data', user, owned.ops);
    expect(owned.calls).toContain('chown1 /data/outbox.jsonl 0:0');
    const absent = fakeOps({}, [...missing, '/data/outbox.jsonl']);
    secureNode('/data', user, absent.ops);
    expect(absent.calls.join('\n')).not.toContain('outbox.jsonl');
  });
});

describe('prepareFolder', () => {
  it('hands the folder to the user and closes it to everyone else', () => {
    const { ops, calls } = fakeOps();
    expect(prepareFolder('/data/subs/a', { uid: 20000, gid: 20000 }, ops)).toBe('/data/subs/a');
    expect(calls).toEqual(['mkdir /data/subs/a', 'chown /data/subs/a 20000:20000', 'chmod /data/subs/a 700']);
  });

  it('skips the walk over a folder the user already owns', () => {
    const { ops, calls } = fakeOps({ '/data/subs/a': 20000 });
    prepareFolder('/data/subs/a', { uid: 20000, gid: 20000 }, ops);
    expect(calls).toEqual(['mkdir /data/subs/a', 'chmod /data/subs/a 700']);
  });

  it('only makes the folder when there is no user', () => {
    const { ops, calls } = fakeOps();
    prepareFolder('/data/subs/a', null, ops);
    expect(calls).toEqual(['mkdir /data/subs/a']);
  });
});

describe('ensurePasswd', () => {
  it('adds the user to passwd and group once, so programs can look it up', () => {
    const dir = tmp();
    const files = { passwd: join(dir, 'passwd'), group: join(dir, 'group') };
    writeFileSync(files.passwd, 'root:x:0:0:root:/root:/bin/bash\n');
    writeFileSync(files.group, 'root:x:0:\n');
    ensurePasswd({ uid: 20000, gid: 20000 }, '/data/subs/a', files);
    ensurePasswd({ uid: 20000, gid: 20000 }, '/data/subs/a', files);
    expect(readFileSync(files.passwd, 'utf8')).toBe('root:x:0:0:root:/root:/bin/bash\nhh20000:x:20000:20000:Hornhoof agent:/data/subs/a:/bin/bash\n');
    expect(readFileSync(files.group, 'utf8')).toBe('root:x:0:\nhh20000:x:20000:\n');
  });
});

describe('runProgram as a user', () => {
  it('passes the uid and gid to the program', async () => {
    const user = { uid: process.getuid!(), gid: process.getgid!() };
    const done = await runProgram({ bin: 'node', args: ['-e', 'console.log(process.getuid())'], env: process.env, timeoutMs: 2_147_483_647, user });
    expect(done).toMatchObject({ code: 0, output: `${user.uid}\n` });
  });
});

describe('builtinAdapters', () => {
  it('prepares a separate home and work folder for each subscription as root', async () => {
    const dir = tmp();
    const { ops, calls } = fakeOps();
    const files = { passwd: join(dir, 'passwd'), group: join(dir, 'group') };
    writeFileSync(files.passwd, '');
    writeFileSync(files.group, '');
    const pick = builtinAdapters(dir, join(dir, 'tools'), { isRoot: true, ops, files });
    const job = (subscriptionId: string) => ({ type: 'job.run' as const, jobId: `job-${subscriptionId}`, subscriptionId, provider: 'anthropic_api' as const, prompt: 'hi', sessionId: null, model: null, timeoutMs: 1000, secret: null, instructions: null, toolToken: null });
    pick(job('sub-a'));
    pick(job('sub-b'));
    expect(calls).toContain(`chown ${join(dir, 'subs', 'sub-a')} 20000:20000`);
    expect(calls).toContain(`chown ${join(dir, 'subs', 'sub-b')} 20001:20001`);
    expect(readFileSync(files.passwd, 'utf8')).toContain(`hh20001:x:20001:20001:Hornhoof agent:${join(dir, 'subs', 'sub-b')}:/bin/bash`);
  });

  it("names the key's user and home, and hands a folder to that user", async () => {
    const dir = tmp();
    const { ops, calls } = fakeOps();
    const files = { passwd: join(dir, 'passwd'), group: join(dir, 'group') };
    writeFileSync(files.passwd, '');
    writeFileSync(files.group, '');
    const pick = builtinAdapters(dir, join(dir, 'tools'), { isRoot: true, ops, files });
    const adapter = pick({ type: 'job.run', jobId: 'job-a', subscriptionId: 'sub-a', provider: 'anthropic_api', prompt: 'hi', sessionId: null, model: null, timeoutMs: 1000, secret: null, instructions: null, toolToken: null });
    expect(adapter.owner).toMatchObject({ user: { uid: 20000, gid: 20000 }, home: join(dir, 'subs', 'sub-a') });
    adapter.owner!.prepare(join(dir, 'work', 'agents', 'a1'));
    expect(calls).toContain(`chown ${join(dir, 'work', 'agents', 'a1')} 20000:20000`);
  });

  it("gives each agent of one company key a user and home of its own, so none reads another's tool token", async () => {
    const dir = tmp();
    const { ops } = fakeOps();
    const files = { passwd: join(dir, 'passwd'), group: join(dir, 'group') };
    writeFileSync(files.passwd, '');
    writeFileSync(files.group, '');
    const pick = builtinAdapters(dir, join(dir, 'tools'), { isRoot: true, ops, files });
    const job = (key: string | null) => ({ type: 'job.run' as const, jobId: `job-${key}`, subscriptionId: 'sub-a', provider: 'anthropic_api' as const, prompt: 'hi', sessionId: null, model: null, timeoutMs: 1000, secret: null, instructions: null, toolToken: null, workspace: key ? { key, repo: null } : null });
    expect(pick(job('agent-1')).owner).toMatchObject({ user: { uid: 20000, gid: 20000 }, home: join(dir, 'agents', 'agent-1') });
    expect(pick(job('agent-2')).owner).toMatchObject({ user: { uid: 20001, gid: 20001 }, home: join(dir, 'agents', 'agent-2') });
    expect(pick(job(null)).owner).toMatchObject({ user: { uid: 20002, gid: 20002 }, home: join(dir, 'subs', 'sub-a') });
    expect(pick(job('agent-1')).owner).toMatchObject({ user: { uid: 20000, gid: 20000 } });
  });
});

/* A user this test cannot become: a program started as that user fails, which shows the user was passed on. */
describe("a root node's own runs of the agents' program", () => {
  const other = { uid: process.getuid!() + 1, gid: process.getgid!() + 1 };
  const io = () => ({ input: new PassThrough(), output: new PassThrough(), urlFile: join(tmp(), 'login-url') });
  const bin = 'agents-program';

  it("checks the sign-in and signs in as the agents' user, so the program leaves nothing in their home they cannot read", async () => {
    started.length = 0;
    expect(await exitsCleanly(process.execPath, ['-e', ''], process.env)).toBe(true);
    await expect(interactiveLogin(process.execPath, ['-e', ''], process.env, io())).resolves.toBeUndefined();
    expect(started.map(s => [s.uid, s.gid])).toEqual([[undefined, undefined], [undefined, undefined]]);
    started.length = 0;
    expect(await exitsCleanly(bin, [], process.env, other)).toBe(false);
    await expect(interactiveLogin(bin, [], process.env, io(), other)).rejects.toThrow();
    const home = tmp();
    expect(await claudeAdapter({ home, tools: home, bin, mode: 'plan', user: other }).loggedIn()).toBe(false);
    expect(await codexAdapter({ home, tools: home, bin, mode: 'plan', user: other }).loggedIn()).toBe(false);
    await expect(kimiAdapter({ home, tools: home, bin, user: other }).login(io())).rejects.toThrow();
    await expect(claudeAdapter({ home, tools: home, bin, mode: 'plan', user: other }).login(io())).rejects.toThrow();
    await expect(codexAdapter({ home, tools: home, bin, mode: 'plan', user: other }).login(io())).rejects.toThrow();
    const asAgents = started.filter(s => s.file === bin);
    expect(asAgents.length).toBeGreaterThanOrEqual(7);
    expect(asAgents.every(s => s.uid === other.uid && s.gid === other.gid)).toBe(true);
  });
});

describe.skipIf(process.getuid?.() === 0)("a root node's installation of the agents' program", () => {

  it("keeps npm's cache in the private installer home instead of in the agents' home", async () => {
    const tools = tmp();
    mkdirSync(join(tools, 'bin'));
    writeFileSync(join(tools, 'bin', 'npm'), `#!/bin/sh\nprintf '%s\\n' "$HOME" "$NPM_CONFIG_CACHE" > ${join(tools, 'cache')}\n`, { mode: 0o755 });
    await installPackage(tools, 'some-program');
    const [home, cache] = readFileSync(join(tools, 'cache'), 'utf8').trim().split('\n');
    expect(home).not.toBe(process.env.HOME);
    expect(cache).toBe(join(home!, 'cache'));
  });

  /* npm moves the program's folder aside under a name that never changes, and fails with ENOTEMPTY while an earlier,
     cut off installation's copy still lies there. */
  it('clears the copy a cut off installation left aside before npm runs, and nothing else', async () => {
    const tools = tmp();
    const scope = join(tools, 'lib', 'node_modules', '@anthropic-ai');
    mkdirSync(join(scope, '.claude-code-2DTsDk1V'), { recursive: true });
    writeFileSync(join(scope, '.claude-code-2DTsDk1V', 'cli.js'), '');
    for (const kept of ['claude-code', 'sdk', '.claude-code-notes']) mkdirSync(join(scope, kept));
    mkdirSync(join(tools, 'bin'));
    writeFileSync(join(tools, 'bin', 'npm'), `#!/bin/sh\nls -A ${scope} > ${join(tools, 'seen')}\n`, { mode: 0o755 });
    await installPackage(tools, '@anthropic-ai/claude-code');
    expect(readFileSync(join(tools, 'seen'), 'utf8').trim().split('\n').sort()).toEqual(['.claude-code-notes', 'claude-code', 'sdk']);
  });
});

