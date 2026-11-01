import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentUser, builtinAdapters, ensurePasswd, FIRST_UID, prepareFolder, secureNode, userFor, type FolderOps } from '../src/isolation.js';
import { runProgram } from '../src/providers/process.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hh-iso-'));

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
    const { ops, calls } = fakeOps({ '/data': 1000, '/data/node.json': 1000, '/data/tools': 1000, '/data/sessions.json': 0, '/data/home': 1000 }, ['/data/users.json', '/data/login-url', '/data/removed', '/data/.hh-recordings']);
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
    const done = await runProgram({ bin: 'node', args: ['-e', 'console.log(process.getuid())'], env: process.env, timeoutMs: 10000, user });
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
});
