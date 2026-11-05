import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandoffRuntime, type CaptureRequest, type HandoffRuntime, type HandoffSource } from '../src/handoff-runtime.js';
import { accepted, closure, destinationOf, git, id, makeStand, wipFile, wipManifest, WIP_REF, type Stand } from './handoff-stand.js';

let stand: Stand;
let runtime: HandoffRuntime;
const fresh = () => createHandoffRuntime({ resolveTaskWorkspace: async binding => binding.workspaceId === stand.workspace().binding.workspaceId ? stand.workspace() : { code: 'workspace_missing', retryable: false }, journalRoot: stand.journal });
beforeEach(() => { stand = makeStand(); runtime = fresh(); stand.write('src/changed.ts', 'export const changed = 2;\n'); });
afterEach(() => { stand.close(); });

const source = (more: Partial<HandoffSource> = {}): HandoffSource => ({
  jobId: id(100), workspaceId: stand.workspace().binding.workspaceId, assignmentEpoch: 3, programInstanceId: id(101), knownSecrets: [],
  readTaskRecords: async () => 'the words of this job\n', readLastTest: async () => 'the last completed run\n', quiesceEndedTurn: async () => true, ...more,
});
const request = (more: Partial<CaptureRequest> = {}): CaptureRequest => ({
  handoffId: id(10), captureId: id(11), captureSequence: 1, taskNumber: 434, fromJobId: id(100), binding: stand.workspace().binding,
  owner: { uid: process.getuid!(), gid: process.getgid!() }, repo: { url: stand.remote, token: '' }, ...more,
});
const LOST = { ok: false, problem: { phase: 'capture', code: 'source_context_lost', retryable: false } };
const nothingPublished = () => { expect(() => git(stand.remote, 'rev-parse', '--verify', WIP_REF)).toThrow(); };

describe('the source of a capture', () => {
  it('ends the exact program instance first, then reads, and publishes the job records and the last test', async () => {
    const steps: string[] = [];
    runtime.registerHandoffSource(source({
      quiesceEndedTurn: async instance => { steps.push(`quiesce ${instance}`); stand.write('src/changed.ts', 'export const changed = 7;\n'); return true; },
      readLastTest: async () => { steps.push('tests'); return 'the last completed run\n'; },
      readTaskRecords: async () => { steps.push('records'); return 'the words of this job\n'; },
    }));
    accepted(await runtime.captureHandoff(request()));
    expect(steps).toEqual([`quiesce ${id(101)}`, 'tests', 'records']);
    expect(wipFile(stand.remote, 'meta/last-tests.txt')).toBe('the last completed run');
    expect(wipFile(stand.remote, 'meta/conversation-tail.txt')).toBe('the words of this job');
    expect(wipFile(stand.remote, 'files/000001')).toBe('export const changed = 7;');
  });

  it('cleans with the secrets of every job of the assignment, the older ones too', async () => {
    const early = ['early', 'job', 'value'].join('-'), late = ['late', 'job', 'value'].join('-');
    stand.write('src/changed.ts', `export const one = "${early}";\nexport const fine = 1;\n`);
    runtime.registerHandoffSource(source({ knownSecrets: [early] }));
    runtime.registerHandoffSource(source({ jobId: id(102), programInstanceId: id(103), knownSecrets: [late], readTaskRecords: async () => `said ${late}\nsaid ${early}\nsaid nothing\n` }));
    const receipt = accepted(await runtime.captureHandoff(request({ fromJobId: id(102) })));
    expect(receipt.requiresRepair).toBe(true);
    const body = closure(stand.remote).map(object => object.body).join('\n');
    expect(body).not.toContain(early);
    expect(body).not.toContain(late);
    expect(wipFile(stand.remote, 'meta/conversation-tail.txt')).toBe('[redacted]\n[redacted]\nsaid nothing');
  });

  it('asks the instance of the latest job, and accepts a capture for an earlier job of the assignment', async () => {
    const asked: string[] = [];
    const quiesceEndedTurn = async (instance: string) => { asked.push(instance); return true; };
    runtime.registerHandoffSource(source({ quiesceEndedTurn }));
    runtime.registerHandoffSource(source({ jobId: id(102), programInstanceId: id(103), quiesceEndedTurn }));
    accepted(await runtime.captureHandoff(request()));
    expect(asked).toEqual([id(103)]);
  });

  it('says the context is lost for a workspace or job nobody registered, and publishes nothing', async () => {
    expect(await runtime.captureHandoff(request())).toEqual(LOST);
    runtime.registerHandoffSource(source());
    expect(await runtime.captureHandoff(request({ fromJobId: id(999) }))).toEqual(LOST);
    runtime.forgetHandoffSource(source().workspaceId);
    expect(await runtime.captureHandoff(request())).toEqual(LOST);
    nothingPublished();
  });

  it('refuses another assignment of the workspace, and keeps a newer lease from an older one', async () => {
    runtime.registerHandoffSource(source({ assignmentEpoch: 5 }));
    runtime.registerHandoffSource(source({ assignmentEpoch: 3, jobId: id(102) }));
    expect(await runtime.captureHandoff(request())).toEqual({ ok: false, problem: { phase: 'capture', code: 'stale_epoch', retryable: false } });
    nothingPublished();
  });

  it('starts a new assignment without the secrets or jobs of the older', async () => {
    const old = ['older', 'assignment', 'value'].join('-');
    runtime.registerHandoffSource(source({ knownSecrets: [old] }));
    runtime.registerHandoffSource(source({ assignmentEpoch: 4, jobId: id(102) }));
    const binding = { ...stand.workspace().binding, assignmentEpoch: 4 };
    expect(await runtime.captureHandoff(request({ binding }))).toEqual(LOST);
    stand.write('src/changed.ts', `const seen = "${old}";\n`);
    const receipt = accepted(await runtime.captureHandoff(request({ binding, fromJobId: id(102) })));
    expect(receipt.requiresRepair).toBe(false);
  });

  it('waits visibly when the source cannot be stopped, reads nothing and carries no words of it', async () => {
    const reads = vi.fn(async () => 'read');
    const words = ['what', 'the', 'tracker', 'said'].join(' ');
    runtime.registerHandoffSource(source({ readLastTest: reads, readTaskRecords: reads, quiesceEndedTurn: async () => { throw new Error(words); } }));
    const thrown = await runtime.captureHandoff(request());
    expect(thrown).toEqual({ ok: false, problem: { phase: 'capture', code: 'source_not_quiescent', retryable: true } });
    expect(JSON.stringify(thrown)).not.toContain(words);
    runtime.registerHandoffSource(source({ readLastTest: reads, readTaskRecords: reads, quiesceEndedTurn: async () => false }));
    expect(await runtime.captureHandoff(request())).toEqual({ ok: false, problem: { phase: 'capture', code: 'source_not_quiescent', retryable: true } });
    expect(reads).not.toHaveBeenCalled();
    nothingPublished();
  });

  it('says unavailable when a record cannot be read, instead of failing or guessing', async () => {
    const words = ['what', 'the', 'store', 'said'].join(' ');
    runtime.registerHandoffSource(source({ readLastTest: async () => { throw new Error(words); }, readTaskRecords: async () => null }));
    accepted(await runtime.captureHandoff(request()));
    expect(wipManifest(stand.remote).context).toEqual({ diffStat: 'present', lastTests: 'unavailable', conversationTail: 'unavailable' });
    expect(closure(stand.remote).map(object => object.body).join('\n')).not.toContain(words);
  });

  it('answers a sealed capture after a node restart, without a lease and without reading anything', async () => {
    runtime.registerHandoffSource(source());
    const first = accepted(await runtime.captureHandoff(request()));
    runtime = fresh();
    stand.write('src/changed.ts', 'export const changed = 3;\n');
    expect(accepted(await runtime.captureHandoff(request()))).toEqual(first);
    expect(git(stand.remote, 'rev-list', '--count', WIP_REF)).toBe('1');
  });

  it('asks the resolver with the binding it was given and follows its answer', async () => {
    const binding = { ...stand.workspace().binding, workspaceId: id(999) };
    runtime.registerHandoffSource(source({ workspaceId: id(999) }));
    expect(await runtime.captureHandoff(request({ binding }))).toEqual({ ok: false, problem: { phase: 'capture', code: 'workspace_missing', retryable: false } });
  });
});

describe('the restore of a capture', () => {
  it('puts the work on the replacement workspace its own binding resolves to', async () => {
    runtime.registerHandoffSource(source());
    const receipt = accepted(await runtime.captureHandoff(request()));
    const destination = destinationOf(stand);
    const replacement = createHandoffRuntime({ resolveTaskWorkspace: async binding => binding.workspaceId === destination.binding.workspaceId ? destination : { code: 'workspace_missing', retryable: false }, journalRoot: join(stand.root, 'other-journal') });
    const done = await replacement.restoreHandoff({ binding: destination.binding, baseSha: receipt.baseSha, checkpointSha: receipt.checkpointSha, contentDigest: receipt.contentDigest,
      owner: request().owner, repo: request().repo, secrets: [] });
    expect(done).toMatchObject({ ok: true, receipt: { epoch: 4, checkpointSha: receipt.checkpointSha, readyForPrompt: true } });
    expect(readFileSync(join(destination.path, 'src/changed.ts'), 'utf8')).toBe('export const changed = 2;\n');
  });
});
