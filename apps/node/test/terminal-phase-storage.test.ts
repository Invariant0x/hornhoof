import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentEvent, ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_BYTES, PHASE_RECORDS, PhaseStore, phaseHash, sourceHash } from '../src/terminal/phase.js';
import { runJob, type ProviderAdapter, type RunResult } from '../src/runner.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync), fsyncSync: vi.fn(actual.fsyncSync), linkSync: vi.fn(actual.linkSync), statSync: vi.fn(actual.statSync) };
});
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const native = await vi.importActual<typeof import('node:fs')>('node:fs');
const nativeCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
const AGENT = '00000000-0000-4000-8000-000000000075';
const JOB = '00000000-0000-4000-8000-000000000074';
const CANARY = 'synthetic-storage-secret-0123456789';
const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-phase-storage-'));
  roots.push(dir);
  return dir;
}

function attempt(dir: string) {
  return new PhaseStore(dir).begin(AGENT, JOB, 'queued');
}

function records(dir: string): string[] {
  const path = join(dir, 'terminal-phase');
  return existsSync(path) ? readdirSync(path).filter(name => name.endsWith('.json')).map(name => join(path, name)).sort() : [];
}

function launch(phase: ReturnType<typeof attempt>): void {
  phase.launch('synthetic-session', sourceHash(import.meta.url), { goesOn: false, sameSession: false, hashMatch: false });
}

function runWithResult(dir: string, result: RunResult, events: AgentEvent[]) {
  const run = vi.fn(async () => result);
  const adapter: ProviderAdapter = { install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [CANARY], run };
  const message: Extract<ServerMessage, { type: 'job.run' }> = { type: 'job.run', jobId: JOB, provider: 'kimi', subscriptionId: 'synthetic', prompt: 'synthetic', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null, workspace: { key: AGENT, repo: null } };
  return { run, pending: runJob(adapter, message, dir, { untimed: true, onEvent: event => events.push(event) }) };
}

afterEach(() => {
  vi.mocked(writeSync).mockImplementation(native.writeSync);
  vi.mocked(fsyncSync).mockImplementation(native.fsyncSync);
  vi.mocked(linkSync).mockImplementation(native.linkSync);
  vi.mocked(randomUUID).mockImplementation(nativeCrypto.randomUUID);
  vi.mocked(statSync).mockImplementation(native.statSync);
  vi.clearAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded durable terminal phase storage', () => {
  it('publishes complete private JSON only after file fsync, then fsyncs the directory', () => {
    const dir = root();
    const order: string[] = [];
    vi.mocked(fsyncSync).mockImplementation(fd => {
      order.push(native.fstatSync(fd).isFile() ? 'file-sync' : 'dir-sync');
      native.fsyncSync(fd);
    });
    vi.mocked(linkSync).mockImplementation((stage, file) => {
      expect(order).toContain('file-sync');
      expect(existsSync(file)).toBe(false);
      const bytes = readFileSync(stage);
      expect(JSON.parse(bytes.toString())).toMatchObject({ trace: 'hh-terminal-phase-v1', jobId: JOB, agentKey: AGENT });
      native.linkSync(stage, file);
      expect(readFileSync(file)).toEqual(bytes);
      order.push('publish');
    });
    const phase = attempt(dir);
    const files = records(dir);
    expect(files).toHaveLength(1);
    const bytes = readFileSync(files[0]!);
    expect(phase.summary()).toContain(`sha256=${createHash('sha256').update(bytes).digest('hex')}`);
    expect(phase.summary()).toContain('durable=true');
    expect(order.indexOf('file-sync')).toBeLessThan(order.indexOf('publish'));
    expect(order.lastIndexOf('dir-sync')).toBeGreaterThan(order.indexOf('publish'));
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'terminal-phase')).mode & 0o777).toBe(0o700);
  });

  it('completes a real short write rather than publishing a partial JSON record', () => {
    const dir = root();
    vi.mocked(writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      if (!Buffer.isBuffer(data)) throw new Error('Expected a bounded byte buffer.');
      return native.writeSync(fd, data, 0, Math.floor(data.length / 2));
    });
    const phase = attempt(dir);
    expect(phase.summary()).toContain('durable=true');
    expect(JSON.parse(readFileSync(records(dir)[0]!, 'utf8'))).toMatchObject({ trace: 'hh-terminal-phase-v1', jobId: JOB });
    expect(vi.mocked(writeSync).mock.calls.length).toBe(2);
  });

  it('never publishes a partial failed write or serializes its error/cause/stack', () => {
    const dir = root();
    vi.mocked(writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      if (!Buffer.isBuffer(data)) throw new Error('Expected a byte buffer.');
      return native.writeSync(fd, data, 0, 17);
    }).mockImplementationOnce(() => { throw new Error(CANARY, { cause: new Error(CANARY) }); });
    const phase = attempt(dir);
    expect(records(dir)).toEqual([]);
    expect(readdirSync(join(dir, 'terminal-phase'))).toEqual([]);
    expect(phase.summary()).toContain('durable=false');
    expect(phase.summary()).toContain('code=io_error');
    expect(phase.summary() + JSON.stringify(phase)).not.toContain(CANARY);
    expect(JSON.stringify(phase)).not.toContain(dir);
  });

  it('does not claim durability when file fsync fails', () => {
    const dir = root();
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (native.fstatSync(fd).isFile()) throw new Error(CANARY);
      native.fsyncSync(fd);
    });
    const phase = attempt(dir);
    expect(records(dir)).toHaveLength(0);
    expect(phase.summary()).toContain('durable=false');
    expect(phase.summary()).not.toContain(CANARY);
  });

  it('reports a gap if directory fsync fails after a complete file became visible', () => {
    const dir = root();
    let published = false;
    vi.mocked(linkSync).mockImplementation((stage, file) => { native.linkSync(stage, file); published = true; });
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (published && native.fstatSync(fd).isDirectory()) throw new Error(CANARY);
      native.fsyncSync(fd);
    });
    const phase = attempt(dir);
    expect(records(dir)).toHaveLength(1);
    expect(JSON.parse(readFileSync(records(dir)[0]!, 'utf8'))).toMatchObject({ jobId: JOB });
    expect(phase.summary()).toContain('durable=false');
    expect(phase.summary()).not.toContain(CANARY);
  });

  it('handles a repeated identical publication without replacing the file', () => {
    const dir = root();
    vi.mocked(linkSync).mockImplementation((stage, file) => { native.linkSync(stage, file); native.linkSync(stage, file); });
    const phase = attempt(dir);
    expect(records(dir)).toHaveLength(1);
    expect(phase.summary()).toContain('durable=true');
    expect(JSON.parse(readFileSync(records(dir)[0]!, 'utf8'))).toMatchObject({ jobId: JOB });
  });

  it('does not replace a conflicting pre-existing file', () => {
    const dir = root();
    let conflict: string | null = null;
    vi.mocked(linkSync).mockImplementation((stage, file) => {
      if (typeof file !== 'string') throw new Error('Expected an owned file path.');
      native.writeFileSync(file, 'foreign bytes', { mode: 0o600 }); conflict = join(dir, 'terminal-phase', basename(file));
      native.linkSync(stage, file);
    });
    const phase = attempt(dir);
    if (!conflict) throw new Error('Expected a conflicting file.');
    expect(readFileSync(conflict, 'utf8')).toBe('foreign bytes');
    expect(phase.summary()).toContain('durable=false');
    expect(phase.summary()).toContain('code=conflict');
  });

  it('rejects a symlink trace directory without writing outside the configured root', () => {
    const dir = root(); const outside = root();
    symlinkSync(outside, join(dir, 'terminal-phase'));
    const phase = attempt(dir);
    expect(readdirSync(outside)).toEqual([]);
    expect(phase.summary()).toContain('durable=false');
  });

  it('pins the original directory if its pathname is replaced by a symlink during a write', () => {
    const dir = root(); const outside = root();
    mkdirSync(join(dir, 'terminal-phase'), { mode: 0o700 });
    vi.mocked(writeSync).mockImplementationOnce((fd: number, data: unknown) => {
      if (!Buffer.isBuffer(data)) throw new Error('Expected a byte buffer.');
      renameSync(join(dir, 'terminal-phase'), join(dir, 'kept-phase'));
      symlinkSync(outside, join(dir, 'terminal-phase'));
      return native.writeSync(fd, data);
    });
    const phase = attempt(dir);
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(join(dir, 'kept-phase')).filter(name => name.endsWith('.json'))).toHaveLength(1);
    expect(phase.summary()).toContain('durable=false');
  });

  it('bounds source identities, filenames and per-attempt records under repeated observations', () => {
    const dir = root();
    const phase = new PhaseStore(dir).begin(`../${CANARY}`, `../${CANARY}`, 'queued');
    phase.launch(CANARY.repeat(1000), CANARY.repeat(1000), { goesOn: false, sameSession: false, hashMatch: false });
    phase.waitStart('ready', Date.now(), 120_000);
    for (let i = 0; i < 2000; i++) { phase.entered(); phase.pane({ queryOk: false, paneDead: null, queryError: 'query_failed' }); }
    phase.waitEnd('ready', 'query_failed'); phase.finish('ready_query_failed'); phase.complete(false, false);
    const files = records(dir);
    expect(files.length).toBeLessThanOrEqual(PHASE_RECORDS);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.length).toBeLessThanOrEqual(PHASE_BYTES);
      expect(bytes.toString()).not.toContain(CANARY);
      expect(JSON.parse(bytes.toString())).toMatchObject({ jobId: null, agentKey: null, sessionHash: null, gaps: { jobId: 'invalid', agentKey: 'invalid' } });
    }
    expect(JSON.stringify(phase.store)).not.toContain(dir);
  });

  it('keeps prior durable bytes after losing an attempt and creating a new one', () => {
    const dir = root();
    const first = attempt(dir); launch(first); first.waitStart('ready', Date.now(), 120_000);
    const kept = records(dir).map(file => [file, readFileSync(file)] as const);
    const second = new PhaseStore(dir).begin(AGENT, '00000000-0000-4000-8000-000000000076', 'queued');
    launch(second); second.finish('host_exception'); second.complete(false, false);
    for (const [file, bytes] of kept) expect(readFileSync(file)).toEqual(bytes);
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it('ignores other-session/path observations and late mutations of a finished attempt', () => {
    const dir = root();
    const phase = attempt(dir); launch(phase);
    const wire = { source: 'kimi_wire' as const, pathHash: phaseHash('wire-a'), sessionHash: phaseHash('synthetic-session'), sizeBefore: 0, sizeAfter: 17, recordType: 'turn.prompt' as const };
    expect(phase.wire(wire)).toBe(true);
    const before = JSON.stringify(phase);
    expect(phase.wire({ ...wire, sessionHash: phaseHash('other-session') })).toBe(false);
    expect(phase.wire({ ...wire, pathHash: phaseHash('other-file') })).toBe(false);
    expect(JSON.stringify(phase)).toBe(before);
    phase.finish('wire_completed');
    const closed = JSON.stringify(phase);
    phase.entered(); phase.pasted(); phase.session('other'); phase.pane({ queryOk: false, paneDead: null, queryError: 'query_failed' }); phase.wire(wire);
    expect(JSON.stringify(phase)).toBe(closed);
  });

  it('keeps a successful job successful and exposes a bounded gap when persistence fails', async () => {
    const dir = root();
    vi.mocked(fsyncSync).mockImplementation(() => { throw new Error(CANARY); });
    const events: AgentEvent[] = [];
    const result: RunResult = { ok: true, result: 'original success', output: '', error: null, sessionId: null, limits: null };
    const test = runWithResult(dir, result, events);
    expect(await test.pending).toMatchObject({ ok: true, result: 'original success', tail: '', error: null });
    expect(events).toContainEqual({ kind: 'tool_result', ok: false, summary: expect.stringContaining('durable=false') });
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('does not replace the original failure if attempt identity generation fails', async () => {
    const dir = root();
    vi.mocked(randomUUID).mockImplementationOnce(() => { throw new Error(CANARY); });
    const events: AgentEvent[] = [];
    const result: RunResult = { ok: false, result: '', output: 'original provider failure', error: 'agent_failed', sessionId: null, limits: null };
    const test = runWithResult(dir, result, events);
    const done = await test.pending;
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain('original provider failure');
    expect(done.tail + JSON.stringify(events)).not.toContain(CANARY);
    expect(events).toContainEqual({ kind: 'tool_result', ok: false, summary: expect.stringContaining('durable=false') });
  });

  it('retains a readable current wait when its own synthetic producer process exits without completion', () => {
    const dir = root();
    const module = new URL('../src/terminal/phase.ts', import.meta.url).href;
    const script = `import { PhaseStore } from ${JSON.stringify(module)}; const phase = new PhaseStore(process.argv[1]).begin('${AGENT}', '${JOB}', 'queued'); phase.waitStart('ready', Date.now(), 120000); process.exit(23);`;
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, dir], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5000, encoding: 'utf8' });
    expect(child.status).toBe(23);
    const kept = records(dir).map(file => [file, readFileSync(file)] as const);
    expect(kept.length).toBeGreaterThan(0);
    expect(JSON.parse(kept.at(-1)![1].toString())).toMatchObject({ jobId: JOB, phase: 'ready', finish: null, waits: { ready: { budgetMs: 120_000, endedAtUtc: null } } });
    const next = new PhaseStore(dir).begin(AGENT, '00000000-0000-4000-8000-000000000076', 'queued');
    next.finish('runner_exception'); next.complete(false, false);
    for (const [file, bytes] of kept) expect(readFileSync(file)).toEqual(bytes);
  });

  it('rejects an unqualified generated identity without using it in a path or summary', () => {
    const dir = root();
    vi.mocked(randomUUID).mockReturnValueOnce(`${CANARY}-0`);
    const phase = attempt(dir);
    expect(records(dir)).toEqual([]);
    expect(phase.summary()).toContain('durable=false');
    expect(phase.summary()).toContain('code=identity_unavailable');
    expect(phase.summary() + JSON.stringify(phase)).not.toContain(CANARY);
  });

  it('reports an unsupported descriptor path without falling back to an unpinned pathname', () => {
    const dir = root();
    vi.mocked(statSync).mockImplementationOnce(() => { throw new Error(CANARY); });
    const phase = attempt(dir);
    expect(records(dir)).toEqual([]);
    expect(phase.summary()).toContain('code=unsupported_fs');
    expect(phase.summary()).toContain('durable=false');
  });

  it('leaves an unverified typed ack unbound and only accepts its exact ref', () => {
    const dir = root();
    const ref = 'synthetic-typed-ref';
    const phase = new PhaseStore(dir).begin(AGENT, null, 'typed', ref);
    launch(phase); phase.waitStart('done', Date.now(), null); phase.finish('wire_completed'); phase.complete(true, false);
    const before = JSON.stringify(phase);
    phase.bind(JOB, 'other-ref');
    expect(JSON.stringify(phase)).toBe(before);
    phase.bind(JOB);
    expect(phase.toJSON()).toMatchObject({ jobId: null, gaps: { jobId: 'not_bound', binding: 'missing_ref' } });
    const start = phase.toJSON().startedAtUtc;
    phase.bind(JOB, ref);
    expect(phase.toJSON()).toMatchObject({ jobId: JOB, startedAtUtc: start, gaps: { jobId: null, binding: null } });
  });
});
