import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const { TASK43_TRANSFER_V1, Task43Invoke, Task43Receipt, parseNodeMessage, parseServerMessage } = protocol as any;
const REQUEST = '8a3e65b0-6b1a-4f5f-b5f4-cf7e26f0e9a1';
const ATTEMPT = '7f1e8b6d-84a2-4e2b-b8ea-f17cd7db0f20';
const TASK = 'e7e8dd9c-83ec-4a2d-a4c5-bf0a08fbf6a0';
const COMPANY = '5c73c34f-1ec5-4a3e-b1b2-f42f8ccbe98d';
const JOB = '1f1f4c8e-a8f5-4b93-a9b7-31d0b6eb7e64';
const IDS = { requestId: REQUEST, attemptId: ATTEMPT };
const CONTEXT = { ...IDS, taskId: TASK, companyId: COMPANY, jobId: JOB };
const UTC = '2026-11-01T06:00:00.000Z';
const SHA = 'c92e8a8c418dc7290a4296079e75a131d9a6ea5188a52264cda7267f67fe561c';

const serverFrames = [
  { type: 'task43.prepare', ...CONTEXT, role: 'target' },
  { type: 'task43.read', ...IDS, offset: 0 },
  { type: 'task43.write', ...IDS, offset: 0, data: 'YQ==' },
  { type: 'task43.source_finish', ...IDS },
  { type: 'task43.verify', ...IDS },
  { type: 'task43.commit', ...IDS },
  { type: 'task43.abort', ...IDS, reason: 'timeout' },
];
const nodeFrames = [
  { type: 'task43.ready', ...IDS, role: 'target', existing: 'absent' },
  { type: 'task43.chunk', ...IDS, offset: 0, data: 'YQ==' },
  { type: 'task43.ack', ...IDS, nextOffset: 1 },
  { type: 'task43.source_verified', ...IDS, size: 1, sha256: SHA, sourceReadAt: UTC },
  { type: 'task43.verified', ...IDS, size: 1, sha256: SHA, targetVerifiedAt: UTC },
  { type: 'task43.stored', ...IDS, mode: 'copied', size: 1, sha256: SHA, actualPath: '/fixture/task43.tgz', targetVerifiedAt: UTC, storedAt: UTC },
  { type: 'task43.failed', ...IDS, reason: 'hash_mismatch', mayExist: false },
];

const startedReceipt = {
  schema: 'task43-transfer-v1', ...CONTEXT, taskNumber: 56,
  sourceAgentId: 'b8f2e7aa-1fb2-447e-9312-7dc1e12108a6', targetAgentId: '100edb09-da27-4868-9646-5c0118b9934e',
  sourceRelativePath: 'task-43-evidence/review-transfer-r1/task43-review-transfer-r1.tgz', destinationBasename: 'task43-review-transfer-r1.tgz',
  actualPath: null, expectedSize: 2012762, expectedSha256: SHA, actualSize: null, actualSha256: null,
  sourceReadAt: null, targetVerifiedAt: null, storedAt: null, serverReceivedAt: UTC,
  status: 'started', delivered: false, mode: null, errorReason: null, mayExist: false,
};

describe('task43 transfer protocol', () => {
  it('pins the one delegated tuple and exact stream bounds', () => {
    expect(TASK43_TRANSFER_V1).toMatchObject({
      taskNumber: 56,
      sourceAgentId: startedReceipt.sourceAgentId,
      targetAgentId: startedReceipt.targetAgentId,
      relativeSource: startedReceipt.sourceRelativePath,
      destinationBasename: startedReceipt.destinationBasename,
      size: 2012762,
      sha256: SHA,
      chunkBytes: 32768,
      frameBytes: 49152,
      chunks: 62,
      lastChunkBytes: 13914,
    });
  });

  it('round-trips all fourteen strict frames through the existing node and server parsers', () => {
    expect(serverFrames).toHaveLength(7);
    expect(nodeFrames).toHaveLength(7);
    for (const frame of serverFrames) expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
    for (const frame of nodeFrames) expect(parseNodeMessage(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects wrong roles, offsets, reasons and unknown fields', () => {
    expect(parseServerMessage(JSON.stringify({ ...serverFrames[0], role: 'source', extra: '/tmp' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...serverFrames[1], offset: 2012763 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...nodeFrames[2], nextOffset: -1 }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ ...nodeFrames[6], reason: 'raw_database_error' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'task43.chunk', ...IDS, offset: 0, data: 'not base64!' }))).toBeNull();
  });

  it('accepts only the fixed invocation with a UUID and no overrides', () => {
    expect(Task43Invoke.safeParse({ task: 56, requestId: REQUEST }).success).toBe(true);
    for (const input of [
      { task: 57, requestId: REQUEST },
      { task: 56, requestId: 'request-1' },
      { task: 56, requestId: REQUEST, sourceAgentId: startedReceipt.sourceAgentId },
      { task: 56, requestId: REQUEST, path: '/tmp/file' },
    ]) expect(Task43Invoke.safeParse(input).success).toBe(false);
  });

  it('keeps actual values independent and never marks transport as delivered', () => {
    expect(Task43Receipt.safeParse(startedReceipt).success).toBe(true);
    expect(Task43Receipt.safeParse({ ...startedReceipt, delivered: true }).success).toBe(false);
    expect(Task43Receipt.safeParse({ ...startedReceipt, status: 'server_complete' }).success).toBe(false);
    expect(Task43Receipt.safeParse({
      ...startedReceipt,
      status: 'server_complete', actualPath: '/fixture/task43.tgz', actualSize: 2012762, actualSha256: SHA,
      sourceReadAt: UTC, targetVerifiedAt: UTC, storedAt: UTC, mode: 'copied', mayExist: true,
    }).success).toBe(true);
    expect(Task43Receipt.safeParse({ ...startedReceipt, status: 'failed' }).success).toBe(false);
    expect(Task43Receipt.safeParse({ ...startedReceipt, status: 'failed', errorReason: 'timeout' }).success).toBe(true);
  });

  it('keeps old nodes compatible and advertises the optional capability explicitly', () => {
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] }))).not.toBeNull();
    const hello = { type: 'hello', version: '0.5.0', loggedIn: true, running: [], capabilities: ['task43_transfer_v1'] };
    expect(parseNodeMessage(JSON.stringify(hello))).toEqual(hello);
  });
});
