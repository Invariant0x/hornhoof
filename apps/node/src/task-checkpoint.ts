import { spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WorkspaceCommitSha, type VerifiedWorkspace, type WorkspaceProblem } from '@hornhoof/protocol';
import { classifyPath, isSanitized, MAX_FILE_BYTES, REDACTED, sanitizeContent, sanitizeContext, sanitizePath, SANITIZER_VERSION } from './handoff-redaction.js';
import { commitMessage, COMMIT_IDENTITY, createDb, fetchTip, fileId, GitFailed, HandoffFault, lockedGit, Manifest, MAX_EXPORT_BYTES, MAX_EXPORT_FILES, META_FILES, openDb, privateFolder, problemOf, processUid, readVerifiedFile,
  remoteTip, sha256, validRepoPath, verifyWipChain, wipRef, type HandoffCode, type HandoffPhase, type HandoffProblem, type ManifestFile, type RemoteRepo, type WipDb, type WipSnapshot } from './handoff-wip.js';
import type { JobUser } from './isolation.js';
import { gitEnv } from './workspace.js';

export { MAX_EXPORT_FILES } from './handoff-wip.js';

/* The data-only checkpoint of one task. The source is read through a view of the node's own making, so nothing the repository configured runs or even gets read;
   every byte is cleaned twice before the first Git object exists, in a database that never held a raw one. */

export interface CheckpointInput {
  handoffId: string; captureId: string; captureSequence: number; taskId: string; taskNumber: number;
  resolveWorkspace: () => Promise<VerifiedWorkspace | WorkspaceProblem>;
  owner: JobUser; repo: RemoteRepo; journalRoot: string; secrets: readonly string[];
  lastTests: string | null; conversationTail: string | null;
  /* The expected head of the remote task branch when there is one; the registered base otherwise. */
  baseSha?: string;
  declaredOutputs?: readonly string[];
  signal?: AbortSignal;
}
export interface CheckpointReceipt {
  handoffId: string; captureId: string; baseSha: string; checkpointSha: string; sanitizerVersion: string;
  contentDigest: string; redactedFiles: number; omittedFiles: number; requiresRepair: boolean; quiescent: true;
}
export type CheckpointResult = { ok: true; receipt: CheckpointReceipt } | { ok: false; problem: HandoffProblem };

const Identifiers = z.object({ handoffId: z.uuid(), captureId: z.uuid(), taskId: z.uuid() });
const Sealed = z.object({ version: z.literal(1), taskId: z.uuid(), baseSha: WorkspaceCommitSha, checkpointSha: WorkspaceCommitSha, contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sanitizerVersion: z.string(), redactedFiles: z.number().int().min(0), omittedFiles: z.number().int().min(0), requiresRepair: z.boolean() }).strict();
type Sealed = z.infer<typeof Sealed>;

const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const notQuiescent = (): HandoffFault => new HandoffFault('source_not_quiescent', true);
const allSecrets = (input: CheckpointInput): string[] => [...input.secrets, input.repo.token].filter(Boolean);

interface JournalPaths { capture: string; db: string; readback: string; sealed: string; lease: string }

/* Node's own, outside the repository and every agent's home: a folder anybody else can read holds no attempt. */
function journalFor(input: CheckpointInput): JournalPaths {
  mkdirSync(dirname(input.journalRoot), { recursive: true });
  const handoffs = join(input.journalRoot, 'handoffs'), leases = join(handoffs, 'leases'), handoff = join(handoffs, input.handoffId), capture = join(handoff, input.captureId);
  for (const folder of [input.journalRoot, handoffs, leases, handoff, capture]) privateFolder(folder);
  return { capture, db: join(capture, 'export.git'), readback: join(capture, 'readback.git'), sealed: join(capture, 'sealed.json'), lease: join(leases, `${input.taskId}.lock`) };
}
function flock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', '3'], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.once('error', reject);
    child.once('exit', code => { if (code === 0) resolve(); else reject(new HandoffFault('scan_failed')); });
  });
}
/* One publisher per task: the lock lives on this open file, so a crash cannot leave it taken. */
export async function withPublisherLease<T>(file: string, work: () => Promise<T>): Promise<T> {
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { await flock(fd); return await work(); } finally { closeSync(fd); }
}
/* Asks nothing of the workspace: an identifier that is no UUID has no attempt. */
export function captureIsSealed(journalRoot: string, handoffId: string, captureId: string): boolean {
  const ids = z.object({ handoffId: z.uuid(), captureId: z.uuid() }).safeParse({ handoffId, captureId });
  return ids.success && existsSync(join(journalRoot, 'handoffs', ids.data.handoffId, ids.data.captureId, 'sealed.json'));
}
function readSealed(paths: JournalPaths, taskId: string): Sealed | null {
  let raw: string;
  try { raw = readFileSync(paths.sealed, 'utf8'); } catch { return null; }
  const sealed = Sealed.parse(JSON.parse(raw));
  if (sealed.taskId !== taskId) throw new HandoffFault('scan_failed');
  return sealed;
}
function writeSealed(paths: JournalPaths, sealed: Sealed): void {
  const temporary = `${paths.sealed}.new`;
  writeFileSync(temporary, JSON.stringify(sealed), { mode: 0o600 });
  const fd = openSync(temporary, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, paths.sealed);
}

const WORKSPACE_CODES: Partial<Record<WorkspaceProblem['code'], HandoffCode>> = { workspace_missing: 'workspace_missing', binding_stale: 'stale_epoch', node_offline: 'target_unavailable' };
export async function resolved(input: Pick<CheckpointInput, 'resolveWorkspace' | 'taskId' | 'owner'>): Promise<VerifiedWorkspace> {
  const result = await input.resolveWorkspace();
  if ('code' in result) throw new HandoffFault(WORKSPACE_CODES[result.code] ?? 'workspace_ambiguous', result.retryable);
  if (result.binding.taskId !== input.taskId || result.ownerUid !== input.owner.uid) throw new HandoffFault('workspace_ambiguous');
  return result;
}

function sourceGitDir(workspace: VerifiedWorkspace): string {
  const file = readVerifiedFile(workspace.realPath, '.git', workspace.ownerUid, 4096);
  if (file.kind === 'unsafe') {
    if (join(workspace.realPath, '.git') === workspace.gitCommonDir) return workspace.gitCommonDir;
    throw new HandoffFault('workspace_ambiguous');
  }
  const dir = /^gitdir: (\/[^\n]+)\n?$/.exec(file.bytes.toString())?.[1];
  if (!dir || !dir.startsWith(`${workspace.gitCommonDir}/worktrees/`) || dir.split('/').includes('..')) throw new HandoffFault('workspace_ambiguous');
  return dir;
}

type SourceGit = (args: readonly string[]) => Promise<string>;
const VIEW_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';

/* A git folder of the node's own: its settings, a copy of the index, and the source's objects as plain data. The source's config, hooks and locks are never in reach. */
function openView(workspace: VerifiedWorkspace, owner: JobUser): string {
  const index = readVerifiedFile(sourceGitDir(workspace), 'index', workspace.ownerUid, MAX_INDEX_BYTES);
  if (index.kind === 'unsafe') throw new HandoffFault('workspace_ambiguous');
  const dir = mkdtempSync(join(tmpdir(), 'hh-source-view-'));
  mkdirSync(join(dir, 'refs'));
  writeFileSync(join(dir, 'HEAD'), `${workspace.sourceHeadSha}\n`);
  writeFileSync(join(dir, 'config'), VIEW_CONFIG);
  writeFileSync(join(dir, 'index'), index.bytes);
  /* Git trusts an entry's file times only while the index looks newer than the file. Older than any file, it compares every file by content:
     a fresh copy's date would hide an edit of the same size made in the second the index was written. */
  utimesSync(join(dir, 'index'), 1, 1);
  for (const name of ['HEAD', 'config', 'index']) {
    chownSync(join(dir, name), processUid(), owner.gid);
    chmodSync(join(dir, name), 0o640);
  }
  for (const folder of [join(dir, 'refs'), dir]) {
    chownSync(folder, processUid(), owner.gid);
    chmodSync(folder, 0o750);
  }
  return dir;
}
export type SourceReader = Pick<CheckpointInput, 'owner' | 'signal' | 'declaredOutputs'>;
async function withSourceView<T>(workspace: VerifiedWorkspace, input: SourceReader, work: (git: SourceGit) => Promise<T>): Promise<T> {
  const dir = openView(workspace, input.owner);
  const env = { GIT_DIR: dir, GIT_WORK_TREE: workspace.realPath, GIT_INDEX_FILE: join(dir, 'index'), GIT_OBJECT_DIRECTORY: join(workspace.gitCommonDir, 'objects') };
  try {
    return await work(async args => (await lockedGit(args, { cwd: workspace.realPath, user: input.owner, env, signal: input.signal })).toString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

type Action = ManifestFile['action'];
export interface Delta { path: string; action: Action; tracked: boolean; doubtful: boolean }
const ACTIONS: Record<string, Action> = { A: 'add', M: 'replace', T: 'replace', D: 'delete' };
const nulSeparated = (text: string): string[] => text.split('\0').filter(Boolean);

function trackedDeltas(raw: string, deltas: Map<string, Delta>): void {
  const fields = raw.split('\0');
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const status = fields[at]!.slice(-1), path = fields[at + 1]!, action = ACTIONS[status];
    deltas.set(path, { path, action: action ?? 'replace', tracked: true, doubtful: action === undefined });
  }
}
function untrackedDeltas(others: string, deltas: Map<string, Delta>): void {
  for (const listed of nulSeparated(others)) {
    /* Git ends a nested repository's name with a slash and does not look inside. */
    const path = listed.replace(/\/$/, ''), known = deltas.has(path);
    deltas.set(path, { path, action: known ? 'replace' : 'add', tracked: known, doubtful: path !== listed });
  }
}
/* A change the index was told not to look at is still a change. A flag means the comparison above proves nothing about the file. */
function flaggedDeltas(flags: string, deltas: Map<string, Delta>): void {
  for (const line of nulSeparated(flags)) {
    if (line.startsWith('H ')) continue;
    const path = line.slice(2);
    deltas.set(path, { path, action: deltas.get(path)?.action ?? 'replace', tracked: true, doubtful: true });
  }
}
function declaredDeltas(outputs: readonly string[], deltas: Map<string, Delta>): void {
  for (const path of outputs) {
    if (!validRepoPath(path) || classifyPath(path) !== 'task') throw new HandoffFault('unsupported_required_output');
    if (!deltas.has(path)) deltas.set(path, { path, action: 'add', tracked: true, doubtful: false });
  }
}
async function enumerate(git: SourceGit, baseSha: string, input: SourceReader): Promise<Delta[]> {
  const deltas = new Map<string, Delta>();
  trackedDeltas(await git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseSha, '--']), deltas);
  untrackedDeltas(await git(['ls-files', '--others', '--exclude-standard', '-z']), deltas);
  flaggedDeltas(await git(['ls-files', '-v', '-z']), deltas);
  declaredDeltas(input.declaredOutputs ?? [], deltas);
  return [...deltas.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export async function readDeltas(workspace: VerifiedWorkspace, input: SourceReader, baseSha: string): Promise<Delta[]> {
  return withSourceView(workspace, input, async git => {
    await git(['merge-base', '--is-ancestor', baseSha, workspace.sourceHeadSha]).catch((error: unknown) => {
      if (error instanceof GitFailed) throw new HandoffFault('ref_conflict');
      throw error;
    });
    try { return await enumerate(git, baseSha, input); } catch (error) {
      if (error instanceof GitFailed) throw new HandoffFault('scan_failed');
      throw error;
    }
  });
}

interface Planned { file: Omit<ManifestFile, 'id'>; payload: Buffer | null; digest: string | null }
const withheld = (path: string, action: Action): Planned => ({ file: { path, action, mode: null, contentSha256: null, status: 'omitted' }, payload: null, digest: null });

function planDelta(delta: Delta, workspace: VerifiedWorkspace, secrets: readonly string[]): Planned {
  const named = validRepoPath(delta.path) && sanitizePath(delta.path, secrets).clean ? delta.path : REDACTED;
  if (named === REDACTED || delta.doubtful || classifyPath(delta.path) !== 'task') return withheld(named, delta.action);
  if (delta.action === 'delete') return { file: { path: named, action: 'delete', mode: null, contentSha256: null, status: 'clean' }, payload: null, digest: null };
  const read = readVerifiedFile(workspace.realPath, delta.path, workspace.ownerUid, MAX_FILE_BYTES);
  if (read.kind === 'unsafe') return withheld(named, delta.action);
  const content = sanitizeContent(read.bytes, secrets);
  if (content.status === 'omitted') return withheld(named, delta.action);
  return { file: { path: named, action: delta.action, mode: read.mode, contentSha256: sha256(content.bytes), status: content.status }, payload: content.bytes, digest: read.digest };
}

interface Candidate { files: ManifestFile[]; payloads: Map<string, Buffer>; read: Map<string, string>; leftOut: number; context: { diffStat: string; lastTests: string; conversationTail: string } }

function diffStat(files: readonly ManifestFile[], payloads: ReadonlyMap<string, Buffer>, leftOut: number): string {
  const count = (status: ManifestFile['status']) => files.filter(file => file.status === status).length;
  const lines = files.map(file => `${file.action} ${file.status} ${payloads.get(file.id)?.length ?? 0} ${file.path}`);
  return [...lines, `files ${files.length}: clean ${count('clean')}, redacted ${count('redacted')}, omitted ${count('omitted')}; left out as not task work ${leftOut}`, ''].join('\n');
}
/* The first pass: everything that may leave, cleaned, in memory. Generated output and credential stores nobody tracked are only counted. */
function firstPass(deltas: readonly Delta[], workspace: VerifiedWorkspace, input: CheckpointInput, secrets: readonly string[]): Candidate {
  const included = deltas.filter(delta => delta.tracked || classifyPath(delta.path) === 'task');
  if (included.length > MAX_EXPORT_FILES) throw new HandoffFault('export_too_large');
  const files: ManifestFile[] = [], payloads = new Map<string, Buffer>(), read = new Map<string, string>();
  let bytes = 0;
  for (const [index, delta] of included.entries()) {
    const id = fileId(index), planned = planDelta(delta, workspace, secrets);
    files.push({ id, ...planned.file });
    if (planned.digest !== null) read.set(delta.path, planned.digest);
    if (planned.payload) payloads.set(id, planned.payload);
    bytes += planned.payload?.length ?? 0;
    if (bytes > MAX_EXPORT_BYTES) throw new HandoffFault('export_too_large');
  }
  const leftOut = deltas.length - included.length;
  return { files, payloads, read, leftOut, context: { diffStat: sanitizeContext(diffStat(files, payloads, leftOut), secrets), lastTests: sanitizeContext(input.lastTests, secrets), conversationTail: sanitizeContext(input.conversationTail, secrets) } };
}
/* The second pass, before any object exists: what the first left must already be what cleaning leaves. */
function secondPass(candidate: Candidate, secrets: readonly string[]): void {
  const texts = [...Object.values(candidate.context), ...[...candidate.payloads.values()].map(bytes => bytes.toString()), ...candidate.files.map(file => file.path)];
  if (!texts.every(text => isSanitized(text, secrets))) throw new HandoffFault('scan_failed');
}
/* The same answers a second time, or the capture saw a workspace in motion. */
async function assertQuiescent(input: CheckpointInput, first: VerifiedWorkspace, baseSha: string, deltas: readonly Delta[], candidate: Candidate): Promise<void> {
  const again = await resolved(input);
  if (again.sourceHeadSha !== first.sourceHeadSha) throw notQuiescent();
  if (JSON.stringify(await readDeltas(again, input, baseSha)) !== JSON.stringify(deltas)) throw notQuiescent();
  for (const [path, digest] of candidate.read) {
    const read = readVerifiedFile(again.realPath, path, again.ownerUid, MAX_FILE_BYTES);
    if (read.kind === 'unsafe' || read.digest !== digest) throw notQuiescent();
  }
}

async function previousCheckpoint(db: WipDb, input: CheckpointInput, secrets: readonly string[]): Promise<WipSnapshot | null> {
  const tip = await remoteTip(db, input.repo, input.taskId);
  if (tip === null) return null;
  await fetchTip(db, input.repo, input.taskId, tip);
  return verifyWipChain(db, tip, { taskId: input.taskId, secrets });
}
const hashed = (out: Buffer): string => out.toString().trim();
async function writeTree(db: WipDb, entries: readonly (readonly [string, string, string])[]): Promise<string> {
  const lines = entries.map(([mode, sha, name]) => `${mode} ${mode === '040000' ? 'tree' : 'blob'} ${sha}\t${name}\0`);
  return hashed(await db(['mktree', '-z'], { input: lines.join('') }));
}
const writeBlob = async (db: WipDb, bytes: string | Buffer): Promise<string> => hashed(await db(['hash-object', '-w', '--stdin', '--no-filters'], { input: bytes }));

async function writeCommit(db: WipDb, candidate: Candidate, manifestBytes: string, captureId: string, parent: string | null): Promise<string> {
  const { diffStat: stat, lastTests, conversationTail } = candidate.context;
  const meta = await writeTree(db, [['100644', await writeBlob(db, manifestBytes), META_FILES.manifest], ['100644', await writeBlob(db, stat), META_FILES.diffStat],
    ['100644', await writeBlob(db, lastTests), META_FILES.lastTests], ['100644', await writeBlob(db, conversationTail), META_FILES.conversationTail]]);
  const payloads: [string, string, string][] = [];
  for (const [id, bytes] of candidate.payloads) payloads.push(['100644', await writeBlob(db, bytes), id]);
  const root = await writeTree(db, [['040000', meta, 'meta'], ...(payloads.length ? [['040000', await writeTree(db, payloads), 'files'] as const] : [])]);
  return hashed(await db(['commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', commitMessage(captureId)], { env: COMMIT_IDENTITY }));
}
function manifestOf(input: CheckpointInput, workspace: VerifiedWorkspace, baseSha: string, candidate: Candidate, previous: string | null): string {
  return JSON.stringify(Manifest.parse({ version: 1, handoffId: input.handoffId, captureId: input.captureId, captureSequence: input.captureSequence, taskId: input.taskId, taskNumber: input.taskNumber,
    epoch: workspace.binding.assignmentEpoch, baseSha, sourceHeadSha: workspace.sourceHeadSha, previousCheckpointSha: previous, sanitizerVersion: SANITIZER_VERSION, files: candidate.files,
    context: { diffStat: 'present', lastTests: input.lastTests === null ? 'unavailable' : 'present', conversationTail: input.conversationTail === null ? 'unavailable' : 'present' },
    requiresRepair: candidate.files.some(file => file.status !== 'clean') }));
}
const countOf = (files: readonly ManifestFile[], status: ManifestFile['status']): number => files.filter(file => file.status === status).length;

async function sealCapture(input: CheckpointInput, paths: JournalPaths): Promise<Sealed> {
  const workspace = await resolved(input), secrets = allSecrets(input);
  const baseSha = WorkspaceCommitSha.parse(input.baseSha ?? workspace.binding.baseSha);
  const deltas = await readDeltas(workspace, input, baseSha);
  const candidate = firstPass(deltas, workspace, input, secrets);
  await assertQuiescent(input, workspace, baseSha, deltas, candidate);
  secondPass(candidate, secrets);

  rmSync(paths.db, { recursive: true, force: true });
  const db = await createDb(paths.db, input.signal);
  const previous = await previousCheckpoint(db, input, secrets);
  const manifestBytes = manifestOf(input, workspace, baseSha, candidate, previous?.sha ?? null);
  const checkpointSha = await writeCommit(db, candidate, manifestBytes, input.captureId, previous?.sha ?? null);
  const verified = await verifyWipChain(db, checkpointSha, { taskId: input.taskId, secrets });
  const sealed: Sealed = { version: 1, taskId: input.taskId, baseSha, checkpointSha, contentDigest: verified.digest, sanitizerVersion: SANITIZER_VERSION,
    redactedFiles: countOf(candidate.files, 'redacted'), omittedFiles: countOf(candidate.files, 'omitted'), requiresRepair: verified.manifest.requiresRepair };
  writeSealed(paths, sealed);
  return sealed;
}

async function push(db: WipDb, input: CheckpointInput, sha: string): Promise<void> {
  try {
    await db(['push', '--quiet', '--porcelain', '--no-verify', '--', input.repo.url, `${sha}:${wipRef(input.taskId)}`], { env: gitEnv(input.repo) });
  } catch (error) {
    if (!(error instanceof GitFailed)) throw error;
    throw /^!/m.test(error.stdout) ? new HandoffFault('ref_conflict') : new HandoffFault('network_unavailable', true);
  }
}
/* What the remote really holds, into a database that held nothing, before anybody hears "saved". */
async function readBack(input: CheckpointInput, paths: JournalPaths, sealed: Sealed, secrets: readonly string[]): Promise<void> {
  rmSync(paths.readback, { recursive: true, force: true });
  try {
    const db = await createDb(paths.readback, input.signal);
    if ((await remoteTip(db, input.repo, input.taskId)) !== sealed.checkpointSha) throw new HandoffFault('ref_conflict');
    await fetchTip(db, input.repo, input.taskId, sealed.checkpointSha);
    const seen = await verifyWipChain(db, sealed.checkpointSha, { taskId: input.taskId, secrets });
    if (seen.digest !== sealed.contentDigest) throw new HandoffFault('ref_conflict');
  } finally { rmSync(paths.readback, { recursive: true, force: true }); }
}
/* An ordinary fast-forward from the checkpoint this one was built on, never over anything else, and no force anywhere. */
async function publish(input: CheckpointInput, paths: JournalPaths, sealed: Sealed): Promise<void> {
  const db = openDb(paths.db, input.signal), secrets = allSecrets(input);
  const snapshot = await verifyWipChain(db, sealed.checkpointSha, { taskId: input.taskId, secrets });
  if (snapshot.digest !== sealed.contentDigest) throw new HandoffFault('scan_failed');
  const tip = await remoteTip(db, input.repo, input.taskId);
  if (tip !== sealed.checkpointSha) {
    if (tip !== snapshot.manifest.previousCheckpointSha) throw new HandoffFault('ref_conflict');
    await push(db, input, sealed.checkpointSha);
  }
  await readBack(input, paths, sealed, secrets);
}

export async function captureTaskCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
  let phase: HandoffPhase = 'capture';
  try {
    Identifiers.parse(input);
    if (input.signal?.aborted) throw new HandoffFault('cancelled');
    const paths = journalFor(input);
    return await withPublisherLease(paths.lease, async () => {
      const sealed = readSealed(paths, input.taskId) ?? await sealCapture(input, paths);
      phase = 'publish';
      await publish(input, paths, sealed);
      const { baseSha, checkpointSha, sanitizerVersion, contentDigest, redactedFiles, omittedFiles, requiresRepair } = sealed;
      return { ok: true, receipt: { handoffId: input.handoffId, captureId: input.captureId, baseSha, checkpointSha, sanitizerVersion, contentDigest, redactedFiles, omittedFiles, requiresRepair, quiescent: true } };
    });
  } catch (error) {
    return { ok: false, problem: problemOf(error, phase) };
  }
}
