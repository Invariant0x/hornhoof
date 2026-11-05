import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import { WorkspaceCommitSha } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { classifyPath, isSanitized, MAX_CONTEXT_BYTES, REDACTED, sanitizePath } from './handoff-redaction.js';
import { gitEnv } from './workspace.js';

/* The format of a WIP checkpoint and the one check of it, shared by the capture that writes it and the restore that trusts nothing it reads. */

export type HandoffCode = 'workspace_missing' | 'workspace_ambiguous' | 'source_context_lost' | 'source_not_quiescent' | 'stale_epoch' | 'ref_conflict'
  | 'unsafe_required_payload' | 'export_too_large' | 'scan_failed' | 'network_unavailable' | 'target_unavailable' | 'restore_failed'
  | 'unsupported_required_output' | 'deadline' | 'cancelled';
export type HandoffPhase = 'capture' | 'publish' | 'restore';
export interface HandoffProblem { phase: HandoffPhase; code: HandoffCode; retryable: boolean }

export class HandoffFault extends Error {
  constructor(readonly code: HandoffCode, readonly retryable = false) { super(code); }
}
/* Fixed words only: an exception can hold a path, an address or what a program printed. */
export function problemOf(error: unknown, phase: HandoffPhase): HandoffProblem {
  return error instanceof HandoffFault ? { phase, code: error.code, retryable: error.retryable } : { phase, code: 'scan_failed', retryable: false };
}

export const MAX_EXPORT_FILES = 2000;
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_CHAIN = 256;
const MAX_GIT_OUTPUT = 128 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const wipRef = (taskId: string): string => `refs/heads/wip/task-${taskId}`;
export const fileId = (index: number): string => String(index + 1).padStart(6, '0');
export const META_FILES = { manifest: 'manifest.json', diffStat: 'diff-stat.txt', lastTests: 'last-tests.txt', conversationTail: 'conversation-tail.txt' } as const;
const META_NAMES = Object.values(META_FILES).sort();

const ManifestFile = z.object({
  id: z.string().regex(/^\d{6}$/), path: z.string().min(1).max(4096), action: z.enum(['add', 'replace', 'delete']),
  mode: z.enum(['100644', '100755']).nullable(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), status: z.enum(['clean', 'redacted', 'omitted']),
}).strict();
export type ManifestFile = z.infer<typeof ManifestFile>;
export const Manifest = z.object({
  version: z.literal(1), handoffId: z.uuid(), captureId: z.uuid(), captureSequence: z.number().int().min(0), taskId: z.uuid(), taskNumber: z.number().int().min(1),
  epoch: z.number().int().min(0), baseSha: WorkspaceCommitSha, sourceHeadSha: WorkspaceCommitSha, previousCheckpointSha: WorkspaceCommitSha.nullable(), sanitizerVersion: z.string().min(1).max(100),
  files: z.array(ManifestFile).max(MAX_EXPORT_FILES),
  context: z.object({ diffStat: z.literal('present'), lastTests: z.enum(['present', 'unavailable']), conversationTail: z.enum(['present', 'unavailable']) }).strict(),
  requiresRepair: z.boolean(),
}).strict();
export type Manifest = z.infer<typeof Manifest>;

/* Literal, relative, inside the repository: the only spelling a restore will write to. */
export function validRepoPath(path: string): boolean {
  return !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function fileIsConsistent(file: ManifestFile, index: number): boolean {
  if (file.id !== fileId(index) || (file.path !== REDACTED && !validRepoPath(file.path))) return false;
  const carries = file.contentSha256 !== null && file.mode !== null, empty = file.contentSha256 === null && file.mode === null;
  if (file.status === 'omitted') return empty;
  if (file.path === REDACTED || classifyPath(file.path) !== 'task') return false;
  return file.action === 'delete' ? file.status === 'clean' && empty : carries;
}
function manifestIsConsistent(manifest: Manifest): boolean {
  const named = manifest.files.map(file => file.path).filter(path => path !== REDACTED);
  return new Set(named).size === named.length && manifest.files.every(fileIsConsistent)
    && manifest.requiresRepair === manifest.files.some(file => file.status !== 'clean');
}

const LOCKED_ENV = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
const LOCKED_OPTIONS = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null', 'core.excludesFile=/dev/null', 'core.untrackedCache=false',
  'gc.auto=0', 'maintenance.auto=false', 'credential.helper=', 'protocol.ext.allow=never'].flatMap(option => ['-c', option]);

export class GitFailed extends Error {
  constructor(readonly stdout: string) { super('git failed'); }
}
export interface GitCall { env?: Record<string, string>; cwd?: string; user?: JobUser; input?: string | Buffer; signal?: AbortSignal | undefined }

function failureOf(error: Error & { killed?: boolean }, stdout: Buffer | string): Error {
  if (error.name === 'AbortError') return new HandoffFault('cancelled');
  return error.killed ? new HandoffFault('deadline', true) : new GitFailed(String(stdout));
}
/* Git with no inherited setting, program or environment; what the words of a failure said stays behind. */
export function lockedGit(args: readonly string[], call: GitCall = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/git', [...LOCKED_OPTIONS, ...args], {
      cwd: call.cwd ?? '/', env: { ...LOCKED_ENV, ...call.env }, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT, timeout: GIT_TIMEOUT_MS,
      ...(call.user ? { uid: call.user.uid, gid: call.user.gid } : {}), ...(call.signal ? { signal: call.signal } : {}),
    }, (error, stdout) => {
      if (error) reject(failureOf(error, stdout));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => { /* A Git that left early answers through its exit. */ });
    child.stdin?.end(call.input);
  });
}

export type WipDb = (args: readonly string[], more?: Pick<GitCall, 'env' | 'input'>) => Promise<Buffer>;
export const openDb = (dir: string, signal?: AbortSignal): WipDb => (args, more = {}) =>
  lockedGit(args, { cwd: dir, env: { GIT_DIR: dir, ...more.env }, ...(more.input === undefined ? {} : { input: more.input }), signal });
export async function createDb(dir: string, signal?: AbortSignal): Promise<WipDb> {
  await lockedGit(['init', '--quiet', '--bare', '--template=', dir], { signal });
  return openDb(dir, signal);
}

async function orFault<T>(work: Promise<T>, code: HandoffCode, retryable = false): Promise<T> {
  try { return await work; } catch (error) {
    if (error instanceof GitFailed) throw new HandoffFault(code, retryable);
    throw error;
  }
}
export interface RemoteRepo { url: string; token: string }
export async function remoteTip(db: WipDb, repo: RemoteRepo, taskId: string): Promise<string | null> {
  const out = await orFault(db(['ls-remote', '--refs', '--', repo.url, wipRef(taskId)], { env: gitEnv(repo) }), 'network_unavailable', true);
  const line = /^([0-9a-f]{40})\t/.exec(out.toString());
  return line ? line[1]! : null;
}
/* The tip into this database and nowhere else, only when it is the commit that was asked for. */
export async function fetchTip(db: WipDb, repo: RemoteRepo, taskId: string, expected: string): Promise<void> {
  await orFault(db(['fetch', '--quiet', '--no-tags', '--no-auto-gc', '--no-recurse-submodules', '--', repo.url, wipRef(taskId)], { env: gitEnv(repo) }), 'network_unavailable', true);
  const fetched = await orFault(db(['rev-parse', 'FETCH_HEAD^{commit}']), 'ref_conflict');
  if (fetched.toString().trim() !== expected) throw new HandoffFault('ref_conflict');
}

const COMMIT = /^tree ([0-9a-f]{40})\n(?:parent ([0-9a-f]{40})\n)?author Hornhoof <checkpoint@hornhoof\.invalid> 1 \+0000\ncommitter Hornhoof <checkpoint@hornhoof\.invalid> 1 \+0000\n\nTask checkpoint ([0-9a-f-]{36})\n$/;
export const COMMIT_IDENTITY = { GIT_AUTHOR_NAME: 'Hornhoof', GIT_AUTHOR_EMAIL: 'checkpoint@hornhoof.invalid', GIT_AUTHOR_DATE: '@1 +0000',
  GIT_COMMITTER_NAME: 'Hornhoof', GIT_COMMITTER_EMAIL: 'checkpoint@hornhoof.invalid', GIT_COMMITTER_DATE: '@1 +0000' };
export const commitMessage = (captureId: string): string => `Task checkpoint ${captureId}`;

interface TreeEntry { mode: string; type: string; sha: string; name: string }
const notAChain = (): HandoffFault => new HandoffFault('ref_conflict');

async function treeEntries(db: WipDb, tree: string): Promise<TreeEntry[]> {
  const listed = await orFault(db(['ls-tree', '-z', tree]), 'ref_conflict');
  return listed.toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode = '', type = '', sha = ''] = line.slice(0, tab).split(' ');
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
}
const readBlob = (db: WipDb, sha: string): Promise<Buffer> => orFault(db(['cat-file', 'blob', sha]), 'ref_conflict');
const plainFile = (entry: TreeEntry): boolean => entry.mode === '100644' && entry.type === 'blob';

function assertClean(bytes: Buffer, secrets: readonly string[]): void {
  if (!isSanitized(bytes.toString(), secrets)) throw new HandoffFault('scan_failed');
}

interface Listing { meta: TreeEntry[]; files: TreeEntry[] }
async function listSnapshot(db: WipDb, tree: string): Promise<Listing> {
  const root = await treeEntries(db, tree), by = (name: string) => root.find(entry => entry.name === name && entry.mode === '040000' && entry.type === 'tree');
  const meta = by('meta'), files = by('files');
  if (!meta || root.length !== (files ? 2 : 1)) throw notAChain();
  const listing = { meta: await treeEntries(db, meta.sha), files: files ? await treeEntries(db, files.sha) : [] };
  const names = listing.meta.map(entry => entry.name).sort();
  if (names.join('\n') !== META_NAMES.join('\n') || !listing.meta.every(plainFile)) throw notAChain();
  if (!listing.files.every(entry => plainFile(entry) && /^\d{6}$/.test(entry.name))) throw notAChain();
  return listing;
}
function parseManifest(bytes: Buffer): Manifest {
  let manifest: Manifest;
  try { manifest = Manifest.parse(JSON.parse(bytes.toString())); } catch { throw notAChain(); }
  if (JSON.stringify(manifest) !== bytes.toString() || !manifestIsConsistent(manifest)) throw notAChain();
  return manifest;
}
async function readPayloads(db: WipDb, manifest: Manifest, files: readonly TreeEntry[], secrets: readonly string[]): Promise<Map<string, Buffer>> {
  const carried = manifest.files.filter(file => file.contentSha256 !== null), payloads = new Map<string, Buffer>();
  if (carried.map(file => file.id).join() !== files.map(entry => entry.name).join()) throw notAChain();
  for (const [index, entry] of files.entries()) {
    const bytes = await readBlob(db, entry.sha);
    if (sha256(bytes) !== carried[index]!.contentSha256) throw notAChain();
    assertClean(bytes, secrets);
    payloads.set(entry.name, bytes);
  }
  return payloads;
}

export interface WipExpectation { taskId: string; secrets: readonly string[] }
export interface WipSnapshot {
  sha: string; manifest: Manifest; digest: string; payloads: Map<string, Buffer>;
  context: { diffStat: Buffer; lastTests: Buffer; conversationTail: Buffer };
}
async function readMeta(db: WipDb, listing: Listing, secrets: readonly string[], name: string): Promise<Buffer> {
  const bytes = await readBlob(db, listing.meta.find(entry => entry.name === name)!.sha);
  if (bytes.length > MAX_CONTEXT_BYTES) throw notAChain();
  assertClean(bytes, secrets);
  return bytes;
}
async function readSnapshot(db: WipDb, sha: string, expect: WipExpectation): Promise<WipSnapshot> {
  const commit = COMMIT.exec((await orFault(db(['cat-file', 'commit', sha]), 'ref_conflict')).toString());
  if (!commit) throw notAChain();
  const listing = await listSnapshot(db, commit[1]!);
  const bytes = await readBlob(db, listing.meta.find(entry => entry.name === META_FILES.manifest)!.sha), manifest = parseManifest(bytes);
  if (manifest.taskId !== expect.taskId || manifest.captureId !== commit[3] || manifest.previousCheckpointSha !== (commit[2] ?? null)) throw notAChain();
  if (manifest.files.some(file => file.path !== REDACTED && !sanitizePath(file.path, expect.secrets).clean)) throw new HandoffFault('scan_failed');
  const part = (name: string) => readMeta(db, listing, expect.secrets, name);
  return { sha, manifest, digest: sha256(bytes), payloads: await readPayloads(db, manifest, listing.files, expect.secrets),
    context: { diffStat: await part(META_FILES.diffStat), lastTests: await part(META_FILES.lastTests), conversationTail: await part(META_FILES.conversationTail) } };
}
/* Every commit, tree and blob reachable from the tip, whatever wrote them. Nothing else can travel with it: a commit links only these. */
export async function verifyWipChain(db: WipDb, tip: string, expect: WipExpectation): Promise<WipSnapshot> {
  const top = await readSnapshot(db, tip, expect);
  let next = top.manifest.previousCheckpointSha;
  for (let depth = 1; next !== null; depth++) {
    if (depth >= MAX_CHAIN) throw notAChain();
    next = (await readSnapshot(db, next, expect)).manifest.previousCheckpointSha;
  }
  return top;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const under = (directory: number, name: string): string => `/proc/self/fd/${directory}/${name}`;

/* Each folder on the way is held open and never followed through a link, so a path cannot be turned to point elsewhere midway. */
export function withPinnedFolder<T>(root: string, parts: readonly string[], use: (folder: number) => T, enter: (folder: number, name: string) => void = () => undefined): T {
  let folder = openSync(root, DIRECTORY);
  try {
    for (const part of parts) {
      enter(folder, part);
      const next = openSync(under(folder, part), DIRECTORY);
      closeSync(folder);
      folder = next;
    }
    return use(folder);
  } finally { closeSync(folder); }
}

export type VerifiedRead = { kind: 'file'; bytes: Buffer; mode: '100644' | '100755'; digest: string } | { kind: 'unsafe' };
const UNSAFE: VerifiedRead = { kind: 'unsafe' };

function readOpened(fd: number, uid: number, limit: number): VerifiedRead {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.size > limit) return UNSAFE;
  const bytes = Buffer.alloc(stat.size + 1);
  let got = 0;
  for (let count = 1; count > 0 && got <= stat.size; got += count) count = readSync(fd, bytes, got, bytes.length - got, null);
  if (got !== stat.size) return UNSAFE;
  const content = bytes.subarray(0, got);
  return { kind: 'file', bytes: content, mode: stat.mode & 0o100 ? '100755' : '100644', digest: sha256(content) };
}
/* A regular file of this owner with one name, or nothing: a link, a device, a hard link into something else or a size past the limit are all alike. */
export function readVerifiedFile(root: string, path: string, uid: number, limit: number): VerifiedRead {
  const parts = path.split('/'), name = parts.pop()!;
  try {
    return withPinnedFolder(root, parts, folder => {
      const fd = openSync(under(folder, name), FILE);
      try { return readOpened(fd, uid, limit); } finally { closeSync(fd); }
    });
  } catch { return UNSAFE; }
}
