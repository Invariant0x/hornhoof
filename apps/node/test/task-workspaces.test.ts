import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskWorkspaceRegistry, type TaskWorkspaceBinding } from '../src/task-workspaces.js';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const nodeId = { kind: 'node' as const, nodeId: id(1) };
const owner = { uid: process.getuid!(), gid: process.getgid!() };
const nodeOwner = { uid: 0, gid: 0 };
let root: string;

/* Actual Git/processes use this test user's UID; only node-owned filesystem metadata is modeled as root. */
const played = vi.hoisted(() => ({ root: null as string | null,
  race: null as null | { path: string; target: string; replacePath?: string },
  grow: null as null | { path: string; bytes: number }, observedPath: '', bytesRead: 0,
}));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const owned = (path: string) => played.root !== null && (path === played.root || path.startsWith(played.root + '/task-workspace-registry'));
  return { ...fs,
    lstatSync: new Proxy(fs.lstatSync, { apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args) as ReturnType<typeof fs.statSync>;
      const path = String(args[0]);
      if (played.race?.path === path) {
        const race = played.race; played.race = null;
        const replaced = race.replacePath ?? path;
        fs.renameSync(replaced, replaced + '.preserved'); fs.symlinkSync(race.target, replaced);
      }
      return value && owned(path) ? Object.assign(value, { uid: 0, gid: 0 }) : value;
    } }),
    fstatSync: new Proxy(fs.fstatSync, { apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args) as ReturnType<typeof fs.statSync>;
      const path = fs.readlinkSync(`/proc/self/fd/${String(args[0])}`);
      if (played.grow?.path === path) {
        const grow = played.grow; played.grow = null; fs.appendFileSync(path, Buffer.alloc(grow.bytes, 'x'));
      }
      return value && owned(path) ? Object.assign(value, { uid: 0, gid: 0 }) : value;
    } }),
    readFileSync: new Proxy(fs.readFileSync, { apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args) as Buffer;
      if (typeof args[0] === 'number' && fs.readlinkSync(`/proc/self/fd/${String(args[0])}`) === played.observedPath) played.bytesRead += value.length;
      return value;
    } }),
    readSync: new Proxy(fs.readSync, { apply(target, receiver, args) {
      const count = Reflect.apply(target, receiver, args) as number;
      if (fs.readlinkSync(`/proc/self/fd/${String(args[0])}`) === played.observedPath) played.bytesRead += count;
      return count;
    } }),
  };
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
  }).trim();
}
function registry() { return createTaskWorkspaceRegistry({ nodeDataDir: root, nodeId, nodeOwner }); }
function fixture(index = 0, repositoryUrl = 'https://example.test/one/app.git') {
  const agentId = id(10), repositoryId = id(20 + index), workspaceId = id(30 + index), taskId = id(40 + index);
  const source = join(root, 'work', 'agents', agentId, 'repositories', repositoryId, 'app');
  const context = join(root, 'work', 'agents', agentId, 'task-workspaces', workspaceId);
  const tree = join(context, 'app');
  mkdirSync(source, { recursive: true }); mkdirSync(context, { recursive: true });
  git(source, 'init', '--quiet', '-b', 'main');
  git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(source, 'file.txt'), 'original\n');
  git(source, 'add', 'file.txt'); git(source, 'commit', '--quiet', '-m', 'Initial');
  git(source, 'remote', 'add', 'origin', repositoryUrl);
  const baseSha = git(source, 'rev-parse', 'HEAD');
  const binding: TaskWorkspaceBinding = { workspaceId, taskId, agentId, nodeId, assignmentEpoch: 0, bindingVersion: 1, repositoryId, taskBranch: `task-${taskId}`, baseSha };
  git(source, 'worktree', 'add', '--quiet', '-b', binding.taskBranch, tree, baseSha);
  return { binding, repositoryUrl, owner, source, context, tree };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hh-workspace-registry-')); played.root = root; played.race = null;
  played.grow = null; played.observedPath = ''; played.bytesRead = 0;
  vi.spyOn(process, 'getuid').mockReturnValue(nodeOwner.uid);
});
afterEach(() => { vi.restoreAllMocks(); played.root = null; played.race = null; rmSync(root, { recursive: true, force: true }); });

describe('frozen task workspace registry producer', () => {
  it('refuses a mapping when the agent UID could also write the node registry', async () => {
    const item = fixture();
    played.root = null; vi.spyOn(process, 'getuid').mockReturnValue(owner.uid);
    const unisolated = createTaskWorkspaceRegistry({ nodeDataDir: root, nodeId, nodeOwner: owner });
    expect(await unisolated.registerTaskWorkspace(item)).toMatchObject({ code: 'wrong_owner' });
  });
  it('records the exact nine-field binding and resolves only its verified linked tree', async () => {
    const item = fixture(), producer = registry();
    const saved = await producer.registerTaskWorkspace(item);
    expect(saved).toEqual({ binding: item.binding, realPath: item.tree, ownerUid: owner.uid, gitCommonDir: join(item.source, '.git'), sourceHeadSha: item.binding.baseSha });
    expect(Object.keys(item.binding).sort()).toEqual(['agentId', 'assignmentEpoch', 'baseSha', 'bindingVersion', 'nodeId', 'repositoryId', 'taskBranch', 'taskId', 'workspaceId']);
    expect(await registry().resolveTaskWorkspace(item.binding)).toEqual(saved);
    const privateRoot = join(root, 'task-workspace-registry');
    expect(lstatSync(privateRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(privateRoot, 'entries', `${item.binding.workspaceId}.json`)).mode & 0o777).toBe(0o600);
  });

  it('does not invent a directory or adopt an unknown tree during readonly resolution', async () => {
    const item = fixture();
    expect(await registry().resolveTaskWorkspace(item.binding)).toEqual({ code: 'workspace_missing', retryable: false });
    expect(readFileSync(join(item.tree, 'file.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(root, 'task-workspace-registry', 'entries', `${item.binding.workspaceId}.json`))).toBe(false);
  });

  it('preserves dirty, ignored, untracked and unpublished continuation bytes on replay', async () => {
    const item = fixture(), producer = registry();
    await producer.registerTaskWorkspace(item);
    writeFileSync(join(item.tree, 'file.txt'), 'committed locally\n');
    git(item.tree, 'commit', '--quiet', '-am', 'Unpublished');
    const head = git(item.tree, 'rev-parse', 'HEAD');
    writeFileSync(join(item.tree, 'file.txt'), 'private dirty continuation\n');
    writeFileSync(join(item.tree, '.gitignore'), 'ignored.data\n');
    writeFileSync(join(item.tree, 'ignored.data'), 'private ignored\n');
    writeFileSync(join(item.tree, 'untracked.data'), 'private untracked\n');
    const before = git(item.tree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored');
    expect(await registry().resolveTaskWorkspace(item.binding)).toMatchObject({ sourceHeadSha: head, realPath: item.tree });
    expect(await producer.registerTaskWorkspace(item)).toMatchObject({ sourceHeadSha: head });
    expect(git(item.tree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored')).toBe(before);
    expect(readFileSync(join(item.tree, 'file.txt'), 'utf8')).toBe('private dirty continuation\n');
    expect(readFileSync(join(item.tree, 'ignored.data'), 'utf8')).toBe('private ignored\n');
    expect(readFileSync(join(item.tree, 'untracked.data'), 'utf8')).toBe('private untracked\n');
  });

  it('never replaces a registered identity with a stale or changed binding', async () => {
    const item = fixture(), producer = registry(); await producer.registerTaskWorkspace(item);
    const file = join(root, 'task-workspace-registry', 'entries', `${item.binding.workspaceId}.json`);
    const bytes = readFileSync(file);
    for (const binding of [{ ...item.binding, bindingVersion: 2 }, { ...item.binding, assignmentEpoch: 1 }, { ...item.binding, taskId: id(99) }]) {
      expect(await producer.resolveTaskWorkspace(binding)).toMatchObject({ code: 'binding_stale' });
      expect(await producer.registerTaskWorkspace({ ...item, binding })).toMatchObject({ code: 'binding_stale' });
      expect(readFileSync(file).equals(bytes)).toBe(true);
    }
  });

  it('rejects extra binding fields and another node without writing an entry', async () => {
    const item = fixture(), producer = registry();
    expect(await producer.registerTaskWorkspace({ ...item, binding: { ...item.binding, version: 1 } })).toMatchObject({ code: 'binding_stale' });
    expect(await producer.registerTaskWorkspace({ ...item, binding: { ...item.binding, nodeId: { kind: 'builtin' } } })).toMatchObject({ code: 'binding_stale' });
    expect(existsSync(join(root, 'task-workspace-registry', 'entries', `${item.binding.workspaceId}.json`))).toBe(false);
  });

  it.each(['task//other', 'task/../other', 'task/other.lock'])('rejects the canonical nonliteral ref %s before registry lookup', async taskBranch => {
    const item = fixture();
    expect(await registry().resolveTaskWorkspace({ ...item.binding, taskBranch })).toEqual({ code: 'binding_stale', retryable: false });
    expect(existsSync(join(root, 'task-workspace-registry', 'entries', `${item.binding.workspaceId}.json`))).toBe(false);
    expect(git(item.tree, 'branch', '--show-current')).toBe(item.binding.taskBranch);
  });

  it('verifies actual owner, source remote and current branch instead of trusting registration', async () => {
    const item = fixture(), producer = registry();
    expect(await producer.registerTaskWorkspace({ ...item, owner: { uid: owner.uid + 1, gid: owner.gid } })).toMatchObject({ code: 'wrong_owner' });
    expect(await producer.registerTaskWorkspace({ ...item, repositoryUrl: 'https://example.test/other/app.git' })).toMatchObject({ code: 'wrong_repository' });
    git(item.tree, 'checkout', '--quiet', '-b', 'other');
    expect(await producer.registerTaskWorkspace(item)).toMatchObject({ code: 'wrong_branch' });
    expect(git(item.source, 'remote', 'get-url', 'origin')).toBe(item.repositoryUrl);
  });

  it('refuses a symlink source and leaves both the link and destination untouched', async () => {
    const item = fixture(), moved = `${item.source}-preserved`;
    renameSync(item.source, moved); symlinkSync(moved, item.source, 'dir');
    expect(await registry().registerTaskWorkspace(item)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(lstatSync(item.source).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(moved, 'file.txt'), 'utf8')).toBe('original\n');
  });

  it('refuses changed inode and git-file identity on an already registered path', async () => {
    const item = fixture(), producer = registry(); await producer.registerTaskWorkspace(item);
    const gitfile = join(item.tree, '.git'), original = readFileSync(gitfile);
    renameSync(gitfile, `${gitfile}.preserved`); writeFileSync(gitfile, original);
    expect(await producer.resolveTaskWorkspace(item.binding)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(readFileSync(`${gitfile}.preserved`).equals(original)).toBe(true);
  });

  it('never reads a replacement symlink after checking the git-file identity', async () => {
    const item = fixture(), outside = join(root, 'unregistered-private-data');
    writeFileSync(outside, 'private fixture bytes'); utimesSync(outside, new Date(0), new Date(0));
    played.race = { path: join(item.tree, '.git'), target: outside };
    expect(await registry().registerTaskWorkspace(item)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(statSync(outside).atimeMs).toBe(0);
    expect(existsSync(join(item.tree, '.git.preserved'))).toBe(true);
  });

  it('refuses an oversized git metadata file without changing its bytes', async () => {
    const item = fixture(), file = join(item.tree, '.git'), bytes = Buffer.alloc(64 * 1024 + 1, 'x');
    writeFileSync(file, bytes);
    expect(await registry().registerTaskWorkspace(item)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('does not read outside the anchored directory after an ancestor is replaced', async () => {
    const item = fixture(), outside = join(root, 'private-directory'); mkdirSync(outside);
    const file = join(outside, '.git'); writeFileSync(file, readFileSync(join(item.tree, '.git'))); utimesSync(file, new Date(0), new Date(0));
    played.race = { path: join(item.tree, '.git'), replacePath: item.tree, target: outside };
    expect(await registry().registerTaskWorkspace(item)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(statSync(file).atimeMs).toBe(0);
    expect(readFileSync(join(item.tree + '.preserved', 'file.txt'), 'utf8')).toBe('original\n');
  });

  it('bounds metadata reads even when a file grows after its size was checked', async () => {
    const item = fixture(), path = join(item.tree, '.git'), original = readFileSync(path);
    played.observedPath = path; played.grow = { path, bytes: 1024 * 1024 };
    expect(await registry().registerTaskWorkspace(item)).toMatchObject({ code: 'workspace_ambiguous' });
    expect(played.bytesRead).toBeLessThanOrEqual(64 * 1024 + 1);
    expect(readFileSync(path).subarray(0, original.length)).toEqual(original);
    expect(statSync(path).size).toBe(original.length + 1024 * 1024);
  });

  it('refuses a regular metadata file replaced by a FIFO without blocking the node', () => {
    const item = fixture(), path = join(item.tree, '.git'), phasesFile = join(root, 'fifo-phases.json');
    const script = `
      import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      const input=JSON.parse(process.argv[1]),options=JSON.parse(process.argv[2]);
      const started=performance.now(),phases=[];
      const mark=phase=>{phases.push({phase,elapsedMs:Math.round(performance.now()-started)});fs.writeFileSync(process.argv[3],JSON.stringify(phases))};
      const lstat=fs.lstatSync,fstat=fs.fstatSync;let replaced=false;
      const privatePath=path=>path===options.nodeDataDir||path.startsWith(options.nodeDataDir+'/task-workspace-registry');
      fs.lstatSync=(path,...args)=>{const s=lstat(path,...args);if(!replaced&&path===input.tree+'/.git'){replaced=true;fs.renameSync(path,path+'.preserved');execFileSync('/usr/bin/mkfifo',[path]);mark('fifo-ready')}return privatePath(String(path))?Object.assign(s,{uid:0,gid:0}):s};
      fs.fstatSync=(fd,...args)=>{const s=fstat(fd,...args);return privatePath(fs.readlinkSync('/proc/self/fd/'+fd))?Object.assign(s,{uid:0,gid:0}):s};
      process.getuid=()=>0;syncBuiltinESMExports();
      mark('import-start');
      const {createTaskWorkspaceRegistry}=await import(${JSON.stringify(new URL('../src/task-workspaces.ts', import.meta.url).href)});
      mark('import-ready');
      const result=await createTaskWorkspaceRegistry(options).registerTaskWorkspace(input);mark('registry-replied');process.stdout.write(JSON.stringify(result));
    `;
    const run = () => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
      JSON.stringify(item), JSON.stringify({ nodeDataDir: root, nodeId, nodeOwner }), phasesFile], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)), timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root },
    });
    const started = performance.now();
    let output: string;
    try { output = run(); }
    finally {
      let phases: unknown;
      try { phases = JSON.parse(readFileSync(phasesFile, 'utf8')); }
      catch { phases = 'unavailable'; }
      process.stdout.write(JSON.stringify({ diagnostic: 'fifo-child', wallMs: Math.round(performance.now() - started), phases }) + '\n');
    }
    expect(JSON.parse(output)).toEqual({ code: 'workspace_ambiguous', retryable: false });
    expect(lstatSync(path).isFIFO()).toBe(true);
    expect(readFileSync(path + '.preserved', 'utf8')).toContain('gitdir:');
  });

  it('keeps equal basenames for different canonical repositories in separate namespaces', async () => {
    const one = fixture(), two = fixture(1, 'https://example.test/two/app.git'), producer = registry();
    const legacy = join(root, 'work', 'agents', one.binding.agentId, 'app'); mkdirSync(legacy); writeFileSync(join(legacy, 'private'), 'legacy bytes');
    const a = await producer.registerTaskWorkspace(one), b = await producer.registerTaskWorkspace(two);
    expect(a).toMatchObject({ realPath: one.tree, gitCommonDir: join(one.source, '.git') });
    expect(b).toMatchObject({ realPath: two.tree, gitCommonDir: join(two.source, '.git') });
    expect(one.tree).not.toBe(two.tree); expect(one.source).not.toBe(two.source);
    expect(readFileSync(join(legacy, 'private'), 'utf8')).toBe('legacy bytes');
  });

  it('never follows a symlink registry root into another writable directory', () => {
    const other = join(root, 'other'); mkdirSync(other); symlinkSync(other, join(root, 'task-workspace-registry'), 'dir');
    expect(() => registry()).toThrow();
    expect(existsSync(join(other, 'entries'))).toBe(false);
  });

  it('does not execute repository fsmonitor or hook code while resolving', async () => {
    const item = fixture(), marker = join(root, 'executed');
    const script = join(root, 'unsafe.sh'); writeFileSync(script, `#!/bin/sh\nprintf x > '${marker}'\n`, { mode: 0o755 });
    git(item.source, 'config', 'core.fsmonitor', script); git(item.source, 'config', 'core.hooksPath', dirname(script));
    const producer = registry(); expect(await producer.registerTaskWorkspace(item)).toMatchObject({ realPath: item.tree });
    expect(await producer.resolveTaskWorkspace(item.binding)).toMatchObject({ realPath: item.tree });
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['release', 'SIGKILL'])('serializes conflicting registrations across two OS processes after lock-owner %s', async mode => {
    const item = fixture(); registry();
    const lock = join(root, 'task-workspace-registry', 'registry.lock');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' };
    const holder = spawn('/usr/bin/flock', ['--exclusive', '--no-fork', lock, process.execPath, '-e', "process.stdout.write('held');process.stdin.resume()"], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const holderEnded = once(holder, 'exit');
    await once(holder.stdout, 'data');
    const script = `
      import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const input=JSON.parse(process.argv[1]),options=JSON.parse(process.argv[2]);
      const lstat=fs.lstatSync,fstat=fs.fstatSync;
      const privatePath=path=>path===options.nodeDataDir||path.startsWith(options.nodeDataDir+'/task-workspace-registry');
      fs.lstatSync=(path,...args)=>{const s=lstat(path,...args);return privatePath(String(path))?Object.assign(s,{uid:0,gid:0}):s};
      fs.fstatSync=(fd,...args)=>{const s=fstat(fd,...args);return privatePath(fs.readlinkSync('/proc/self/fd/'+fd))?Object.assign(s,{uid:0,gid:0}):s};
      process.getuid=()=>0;syncBuiltinESMExports();
      const {createTaskWorkspaceRegistry}=await import(${JSON.stringify(new URL('../src/task-workspaces.ts', import.meta.url).href)});
      const registry=createTaskWorkspaceRegistry(options);process.stdout.write('ready\\n');
      const result=await registry.registerTaskWorkspace(input);process.stdout.write(JSON.stringify(result));
    `;
    const options = { nodeDataDir: root, nodeId, nodeOwner };
    const workers = [1, 2].map(bindingVersion => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
        JSON.stringify({ ...item, binding: { ...item.binding, bindingVersion } }), JSON.stringify(options)], {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', error = '', ended = false;
      child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { error += String(data); });
      const complete = once(child, 'close').then(([code]) => { ended = true; expect(code, error).toBe(0); return JSON.parse(output.slice(output.indexOf('\n') + 1)) as { code?: string; binding?: TaskWorkspaceBinding }; });
      const ready = once(child.stdout, 'data');
      return { child, ready, complete, ended: () => ended };
    });
    try {
      await Promise.all(workers.map(worker => worker.ready));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(workers.map(worker => worker.ended())).toEqual([false, false]);
      expect(existsSync(join(root, 'task-workspace-registry', 'entries', `${item.binding.workspaceId}.json`))).toBe(false);
      if (mode === 'SIGKILL') holder.kill('SIGKILL'); else holder.stdin.end();
      await holderEnded;
      const results = await Promise.all(workers.map(worker => worker.complete));
      expect(results.filter(result => result.code === 'binding_stale')).toHaveLength(1);
      const accepted = results.find(result => result.binding !== undefined)!;
      expect(await registry().resolveTaskWorkspace(accepted.binding!)).toEqual(accepted);
      expect(readFileSync(join(item.tree, 'file.txt'), 'utf8')).toBe('original\n');
    } finally {
      holder.kill('SIGKILL'); holder.stdin.destroy(); await holderEnded;
      for (const worker of workers) worker.child.kill('SIGKILL');
      await Promise.allSettled(workers.map(worker => worker.complete));
    }
  });
});
