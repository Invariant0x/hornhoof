import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { repoFolder, NodeRef as Node, TaskWorkspaceBinding as Binding,
  type NodeRef, type TaskWorkspaceBinding, type VerifiedWorkspace, type WorkspaceProblem } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { inspectWorkspaceGit, repositoryIdentity, WorkspaceFault } from './task-workspace-git.js';

export type { NodeRef, TaskWorkspaceBinding, VerifiedWorkspace, WorkspaceProblem } from '@hornhoof/protocol';
export interface TaskWorkspaceRegistryOptions { nodeDataDir: string; nodeId: NodeRef; nodeOwner: JobUser }
export interface TaskWorkspaceRegistration { binding: TaskWorkspaceBinding; repositoryUrl: string; owner: JobUser }
export interface TaskWorkspaceRegistry {
  registerTaskWorkspace(input: unknown): Promise<VerifiedWorkspace | WorkspaceProblem>;
  resolveTaskWorkspace(binding: TaskWorkspaceBinding): Promise<VerifiedWorkspace | WorkspaceProblem>;
}

const Owner = z.object({ uid: z.number().int().min(1), gid: z.number().int().min(0) }).strict();
const Registration = z.object({ binding: Binding, repositoryUrl: z.string(), owner: Owner });
const Identity = z.object({ dev: z.number(), ino: z.number(), uid: z.number(), gitFileHash: z.string().optional() }).strict();
const Record = z.object({ version: z.literal(1), binding: Binding, repositoryUrl: z.string(), owner: Owner,
  identity: z.object({ source: Identity, tree: Identity, common: Identity, gitFile: Identity }).strict(),
}).strict();
type Registered = z.infer<typeof Record>;
type Paths = { sourcePath: string; realPath: string; gitCommonDir: string };

function stat(path: string): Stats {
  try { return lstatSync(path); } catch { throw new WorkspaceFault('workspace_missing'); }
}
function directory(path: string, uid: number, privateMode = false): void {
  const value = stat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new WorkspaceFault('workspace_ambiguous');
  if (value.uid !== uid || (privateMode && (value.mode & 0o077))) throw new WorkspaceFault('wrong_owner');
}
function privateDirectory(path: string, uid: number): void {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  directory(path, uid, true);
  if (created) syncDirectory(dirname(path));
}
function privateFile(fd: number, uid: number): void {
  const value = fstatSync(fd);
  if (!value.isFile() || value.nlink !== 1 || value.uid !== uid || (value.mode & 0o077)) throw new WorkspaceFault('wrong_owner');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeRecord(file: string, value: Registered, uid: number): void {
  const temporary = `${file}.${randomUUID()}.new`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { privateFile(fd, uid); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file); syncDirectory(dirname(file));
}
function readRecord(file: string, uid: number): Registered | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorkspaceFault('workspace_ambiguous');
  }
  try {
    privateFile(fd, uid);
    if (fstatSync(fd).size > 32 * 1024) throw new WorkspaceFault('workspace_ambiguous');
    return Record.parse(JSON.parse(readLimited(fd, 32 * 1024).toString('utf8')));
  } finally { closeSync(fd); }
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function pathsFor(root: string, binding: TaskWorkspaceBinding, repositoryUrl: string): Paths {
  const agent = join(root, 'work', 'agents', binding.agentId), folder = repoFolder(repositoryUrl);
  const sourcePath = join(agent, 'repositories', binding.repositoryId, folder);
  return { sourcePath, realPath: join(agent, 'task-workspaces', binding.workspaceId, folder), gitCommonDir: join(sourcePath, '.git') };
}
function containedDirectory(root: string, target: string): void {
  const part = relative(root, target);
  if (!part || part.startsWith(`..${sep}`) || part === '..') throw new WorkspaceFault('workspace_ambiguous');
  let path = root;
  for (const name of part.split(sep)) {
    path = join(path, name);
    const value = stat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new WorkspaceFault('workspace_ambiguous');
  }
}
function snapshot(root: string, path: string, uid: number, file = false): z.infer<typeof Identity> {
  const value = stat(path);
  if (value.isSymbolicLink() || (file ? !value.isFile() : !value.isDirectory())) throw new WorkspaceFault('workspace_ambiguous');
  if (value.uid !== uid) throw new WorkspaceFault('wrong_owner');
  if (file && value.nlink !== 1) throw new WorkspaceFault('workspace_ambiguous');
  return { dev: value.dev, ino: value.ino, uid: value.uid, ...(file ? { gitFileHash: metadataHash(root, path, uid, value) } : {}) };
}
/* Each parent is pinned while the next component opens; no agent-owned ancestor is followed. */
function openMetadata(root: string, path: string): number {
  const part = relative(root, path);
  if (!part || part.startsWith(`..${sep}`) || part === '..') throw new WorkspaceFault('workspace_ambiguous');
  const names = part.split(sep), opened: number[] = [];
  try {
    let parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(parent);
    for (const name of names.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(parent);
    }
    return openSync(`/proc/self/fd/${parent}/${names.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch { throw new WorkspaceFault('workspace_ambiguous'); }
  finally { for (const fd of opened.reverse()) closeSync(fd); }
}
function readLimited(fd: number, limit: number): Buffer {
  const bytes = Buffer.alloc(limit + 1);
  let length = 0, count: number;
  do { count = readSync(fd, bytes, length, bytes.length - length, length); length += count; }
  while (count > 0 && length < bytes.length);
  if (length > limit) throw new WorkspaceFault('workspace_ambiguous');
  return bytes.subarray(0, length);
}
function metadataHash(root: string, path: string, uid: number, expected: Stats): string {
  const fd = openMetadata(root, path);
  try {
    const value = fstatSync(fd);
    if (!value.isFile() || value.nlink !== 1 || value.size > 64 * 1024) throw new WorkspaceFault('workspace_ambiguous');
    if (value.uid !== uid) throw new WorkspaceFault('wrong_owner');
    if (value.dev !== expected.dev || value.ino !== expected.ino) throw new WorkspaceFault('workspace_ambiguous');
    return createHash('sha256').update(readLimited(fd, 64 * 1024)).digest('hex');
  } finally { closeSync(fd); }
}
function identity(root: string, paths: Paths, owner: JobUser): Registered['identity'] {
  containedDirectory(root, paths.sourcePath); containedDirectory(root, paths.realPath);
  const source = snapshot(root, paths.sourcePath, owner.uid), tree = snapshot(root, paths.realPath, owner.uid);
  const common = snapshot(root, paths.gitCommonDir, owner.uid), gitFile = snapshot(root, join(paths.realPath, '.git'), owner.uid, true);
  snapshot(root, join(paths.gitCommonDir, 'config'), owner.uid, true);
  return { source, tree, common, gitFile };
}
async function verify(root: string, record: Registered): Promise<VerifiedWorkspace> {
  const paths = pathsFor(root, record.binding, record.repositoryUrl);
  const before = identity(root, paths, record.owner);
  if (!same(before, record.identity)) throw new WorkspaceFault('workspace_ambiguous');
  const sourceHeadSha = await inspectWorkspaceGit({ ...paths, ...record.binding, repositoryUrl: record.repositoryUrl, owner: record.owner });
  if (!same(before, identity(root, paths, record.owner))) throw new WorkspaceFault('workspace_ambiguous');
  return { binding: record.binding, realPath: paths.realPath, ownerUid: record.owner.uid, gitCommonDir: paths.gitCommonDir, sourceHeadSha };
}

async function flock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', '3'], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', fd] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new WorkspaceFault('workspace_switch_unavailable'));
      else resolve();
    });
  });
}
async function withLock<T>(path: string, uid: number, work: () => Promise<T>): Promise<T> {
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try { privateFile(fd, uid); await flock(fd); return await work(); } finally { closeSync(fd); }
}
function problem(error: unknown): WorkspaceProblem {
  return { code: error instanceof WorkspaceFault ? error.code : 'workspace_ambiguous', retryable: false };
}
function bindingFor(input: unknown, node: NodeRef): TaskWorkspaceBinding {
  const parsed = Binding.safeParse(input);
  if (!parsed.success || !same(parsed.data.nodeId, node)) throw new WorkspaceFault('binding_stale');
  return parsed.data;
}

interface RegistryContext { root: string; uid: number; node: NodeRef; entries: string; lock: string }
function registryContext(options: TaskWorkspaceRegistryOptions): RegistryContext {
  const root = resolve(options.nodeDataDir), uid = options.nodeOwner.uid, node = Node.parse(options.nodeId);
  if (realpathSync(root) !== root || process.getuid?.() !== uid) throw new WorkspaceFault('wrong_owner');
  directory(root, uid);
  if (stat(root).mode & 0o022) throw new WorkspaceFault('wrong_owner');
  const privateRoot = join(root, 'task-workspace-registry'), entries = join(privateRoot, 'entries');
  privateDirectory(privateRoot, uid); privateDirectory(entries, uid);
  const lock = join(privateRoot, 'registry.lock');
  const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { privateFile(fd, uid); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(privateRoot);
  return { root, uid, node, entries, lock };
}
function entryFile(context: RegistryContext, binding: TaskWorkspaceBinding): string {
  return join(context.entries, `${binding.workspaceId}.json`);
}
async function register(context: RegistryContext, input: unknown): Promise<VerifiedWorkspace | WorkspaceProblem> {
  const { root, uid, node, lock } = context;
  try {
    const parsed = Registration.safeParse(input);
    if (!parsed.success) throw new WorkspaceFault('binding_stale');
    if (parsed.data.owner.uid === uid) throw new WorkspaceFault('wrong_owner');
    const binding = bindingFor(parsed.data.binding, node), repositoryUrl = repositoryIdentity(parsed.data.repositoryUrl);
    return await withLock(lock, uid, async () => {
      const old = readRecord(entryFile(context, binding), uid);
      if (old) {
        if (!same(old.binding, binding)) throw new WorkspaceFault('binding_stale');
        if (old.repositoryUrl !== repositoryUrl || !same(old.owner, parsed.data.owner)) throw new WorkspaceFault('wrong_repository');
        return verify(root, old);
      }
      const record: Registered = { version: 1, binding, repositoryUrl, owner: parsed.data.owner,
        identity: identity(root, pathsFor(root, binding, repositoryUrl), parsed.data.owner) };
      const verified = await verify(root, record);
      writeRecord(entryFile(context, binding), record, uid);
      return verified;
    });
  } catch (error) { return problem(error); }
}
async function resolveRegistered(context: RegistryContext, input: TaskWorkspaceBinding): Promise<VerifiedWorkspace | WorkspaceProblem> {
  try {
    const binding = bindingFor(input, context.node);
    return await withLock(context.lock, context.uid, async () => {
      const record = readRecord(entryFile(context, binding), context.uid);
      if (!record) throw new WorkspaceFault('workspace_missing');
      if (!same(record.binding, binding)) throw new WorkspaceFault('binding_stale');
      if (record.owner.uid === context.uid) throw new WorkspaceFault('wrong_owner');
      return verify(context.root, record);
    });
  } catch (error) { return problem(error); }
}
export function createTaskWorkspaceRegistry(options: TaskWorkspaceRegistryOptions): TaskWorkspaceRegistry {
  const context = registryContext(options);
  return { registerTaskWorkspace: input => register(context, input), resolveTaskWorkspace: binding => resolveRegistered(context, binding) };
}
