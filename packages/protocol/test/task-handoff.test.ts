import { describe, expect, it } from 'vitest';
import { HandoffAssignment, HandoffControlMessage, HandoffMessage, ResetSource } from '../src/task-handoff.js';
import { parseNodeMessage, parseServerMessage } from '../src/index.js';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const IDS = {
  handoffId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  captureId: '33333333-3333-4333-8333-333333333333',
  reservationId: '44444444-4444-4444-8444-444444444444',
  jobId: '55555555-5555-4555-8555-555555555555',
  candidateAgentId: '66666666-6666-4666-8666-666666666666',
  repositoryId: '77777777-7777-4777-8777-777777777777',
  workspaceId: '88888888-8888-4888-8888-888888888888',
  agentId: '99999999-9999-4999-8999-999999999999',
  nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  fromJobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  cancelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const binding = {
  workspaceId: IDS.workspaceId,
  taskId: IDS.taskId,
  agentId: IDS.agentId,
  nodeId: { kind: 'node', nodeId: IDS.nodeId },
  assignmentEpoch: 3,
  bindingVersion: 2,
  repositoryId: IDS.repositoryId,
  taskBranch: 'task-abc',
  baseSha: SHA,
};
const base = { version: 1, handoffId: IDS.handoffId, taskId: IDS.taskId, binding };
const at = '2026-11-06T06:00:00.000Z';

const valid = {
  capture: { ...base, type: 'task.handoff.capture', fromJobId: IDS.fromJobId, workspaceId: IDS.workspaceId, repositoryId: IDS.repositoryId, expectedWipSha: null, deadline: at },
  saved: { ...base, type: 'task.handoff.saved', captureId: IDS.captureId, baseSha: SHA, checkpointSha: SHA, sanitizerVersion: 'v1', contentDigest: DIGEST, redactedFiles: 2, omittedFiles: 1, requiresRepair: false, quiescent: true },
  problem: { ...base, type: 'task.handoff.problem', captureId: IDS.captureId, phase: 'waiting_repair', code: 'source_context_lost', retryable: true },
  offer: { ...base, type: 'task.handoff.offer', candidateAgentId: IDS.candidateAgentId, repositoryId: IDS.repositoryId, baseSha: SHA, checkpointSha: SHA, deadline: at },
  reserved: { ...base, type: 'task.handoff.reserved', reservationId: IDS.reservationId, expiresAt: at },
  restored: { ...base, type: 'task.handoff.restored', jobId: IDS.jobId, workspaceId: IDS.workspaceId, restoredTreeDigest: DIGEST, readyForPrompt: true },
  accepted: { ...base, type: 'task.handoff.prompt_accepted', captureId: IDS.captureId, jobId: IDS.jobId, workspaceId: IDS.workspaceId, acceptedAt: at },
  resume: { ...base, type: 'task.handoff.resume_source', cancelId: IDS.cancelId, workspaceId: IDS.workspaceId },
  ready: { ...base, type: 'task.handoff.source_ready', cancelId: IDS.cancelId, workspaceId: IDS.workspaceId, captureStopped: true },
  release: { ...base, type: 'task.handoff.release', reservationId: IDS.reservationId, reason: 'stale' },
};

describe('bounded task handoff wire', () => {
  it.each([
    ['capture', valid.capture, HandoffControlMessage],
    ['saved', valid.saved, HandoffMessage],
    ['problem', valid.problem, HandoffMessage],
    ['offer', valid.offer, HandoffControlMessage],
    ['reserved', valid.reserved, HandoffMessage],
    ['restored', valid.restored, HandoffMessage],
    ['prompt_accepted', valid.accepted, HandoffMessage],
    ['resume_source', valid.resume, HandoffControlMessage],
    ['source_ready', valid.ready, HandoffMessage],
    ['release', valid.release, HandoffControlMessage],
  ] as const)('accepts %s with its exact source binding', (_name, packet, schema) => {
    expect(schema.parse(packet)).toEqual(packet);
  });

  it('accepts prompt acceptance for the explicit origin resume permit', () => {
    expect(HandoffMessage.parse({ ...valid.accepted, captureId: null })).toEqual({ ...valid.accepted, captureId: null });
  });

  it('accepts the nested assignment envelope used by job.run', () => {
    const assignment = { ...base, captureId: IDS.captureId, reservationId: IDS.reservationId, baseSha: SHA, checkpointSha: SHA };
    expect(HandoffAssignment.parse(assignment)).toEqual(assignment);
  });

  it('rejects forged stale binding and a second signal hidden in text', () => {
    expect(() => HandoffMessage.parse({ ...valid.saved, binding: { ...binding, assignmentEpoch: 0, bindingVersion: 0 })).toThrow();
    expect(() => HandoffMessage.parse({ ...valid.saved, text: 'model access denied' })).toThrow();
    expect(() => HandoffControlMessage.parse({ ...valid.offer, exitCode: 1 })).toThrow();
  });

  it('rejects malformed ids, refs and out-of-bounds metadata', () => {
    expect(() => HandoffMessage.parse({ ...valid.saved, captureId: 'not-a-uuid' })).toThrow();
    expect(() => HandoffMessage.parse({ ...valid.saved, checkpointSha: 'not-a-sha' })).toThrow();
    expect(() => HandoffMessage.parse({ ...valid.saved, sanitizerVersion: 'v'.repeat(41) })).toThrow();
    expect(() => HandoffMessage.parse({ ...valid.saved, contentDigest: 'not-a-digest' })).toThrow();
    expect(() => HandoffControlMessage.parse({ ...valid.capture, deadline: 'not-a-time' })).toThrow();
  });

  it('keeps provider and probe reset provenance distinct, with unknown as the only other source', () => {
    expect(ResetSource.parse('provider')).toBe('provider');
    expect(ResetSource.parse('probe')).toBe('probe');
    expect(() => ResetSource.parse('unknown-reset')).toThrow();
  });

  it('parses the actual node and server boundaries, including job.run assignment', () => {
    expect(parseNodeMessage(JSON.stringify(valid.saved))).toEqual(valid.saved);
    expect(parseNodeMessage(JSON.stringify(valid.ready))).toEqual(valid.ready);
    expect(parseServerMessage(JSON.stringify(valid.capture))).toEqual(valid.capture);
    expect(parseServerMessage(JSON.stringify(valid.offer))).toEqual(valid.offer);
    expect(parseServerMessage(JSON.stringify(valid.resume))).toEqual(valid.resume);
    expect(parseServerMessage(JSON.stringify(valid.release))).toEqual(valid.release);
    const assignment = { ...base, captureId: IDS.captureId, reservationId: IDS.reservationId, baseSha: SHA, checkpointSha: SHA };
    const run = {
      type: 'job.run', jobId: IDS.jobId, subscriptionId: IDS.reservationId, provider: 'codex', prompt: 'Resume', sessionId: null, model: null,
      timeoutMs: 1000, secret: null, instructions: null, toolToken: null, taskId: IDS.taskId, workspaceId: IDS.workspaceId, assignmentEpoch: 3, handoff: assignment,
    };
    expect(parseServerMessage(JSON.stringify(run))).toEqual(run);
  });
});
