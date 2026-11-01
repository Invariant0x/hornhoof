import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK43_TRANSFER_V1, type Task43NodeMessage, type Task43ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createTask43Node, type Task43Node } from '../src/task43-transfer.js';

const SOURCE = TASK43_TRANSFER_V1.sourceAgentId;
const TARGET = TASK43_TRANSFER_V1.targetAgentId;
const SIZE = TASK43_TRANSFER_V1.size;
const DATA = Buffer.alloc(SIZE);
for (let index = 0; index < SIZE; index++) DATA[index] = index % 251;
const SHA256 = createHash('sha256').update(DATA).digest('hex');
const POLICY = { ...TASK43_TRANSFER_V1, sha256: SHA256 };
const IDS = { requestId: '8a3e65b0-6b1a-4f5f-b5f4-cf7e26f0e9a1', attemptId: '7f1e8b6d-84a2-4e2b-b8ea-f17cd7db0f20' };
const CONTEXT = { ...IDS, taskId: 'e7e8dd9c-83ec-4a2d-a4c5-bf0a08fbf6a0', companyId: '5c73c34f-1ec5-4a3e-b1b2-f42f8ccbe98d', jobId: '1f1f4c8e-a8f5-4b93-a9b7-31d0b6eb7e64' };

type Fixture = ReturnType<typeof fixture>;
function fixture(data = DATA) {
  const dir = mkdtempSync(join(tmpdir(), 'task43-node-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'work', 'agents');
  const source = join(root, SOURCE);
  const target = join(root, TARGET);
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  const sourceFile = join(source, TASK43_TRANSFER_V1.relativeSource);
  mkdirSync(join(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, data);
  return { dir, root, source, target, sourceFile, final: join(target, TASK43_TRANSFER_V1.destinationBasename) };
}

async function adapter(current: Fixture, options: { helperPath?: string } = {}) {
  const sent: Task43NodeMessage[] = [];
  const node = await createTask43Node({ dir: current.dir, policy: POLICY, send: message => void sent.push(message), ...options });
  return { node, sent };
}

async function exchange(node: Task43Node, sent: Task43NodeMessage[], frame: Task43ServerMessage): Promise<Task43NodeMessage> {
  sent.length = 0;
  await node.handle(frame);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

async function copy(source: Task43Node, sourceSent: Task43NodeMessage[], target: Task43Node, targetSent: Task43NodeMessage[]) {
  const targetReady = await exchange(target, targetSent, { type: 'task43.prepare', ...CONTEXT, role: 'target' });
  expect(targetReady).toMatchObject({ type: 'task43.ready', existing: 'absent' });
  const sourceReady = await exchange(source, sourceSent, { type: 'task43.prepare', ...CONTEXT, role: 'source' });
  expect(sourceReady).toMatchObject({ type: 'task43.ready', role: 'source', existing: 'absent' });
  let chunks = 0;
  for (let offset = 0; offset < SIZE;) {
    const chunk = await exchange(source, sourceSent, { type: 'task43.read', ...IDS, offset });
    expect(chunk.type).toBe('task43.chunk');
    if (chunk.type !== 'task43.chunk') throw new Error('chunk expected');
    const ack = await exchange(target, targetSent, { type: 'task43.write', ...IDS, offset, data: chunk.data });
    expect(ack.type).toBe('task43.ack');
    offset += Buffer.from(chunk.data, 'base64').length;
    chunks++;
  }
  expect(chunks).toBe(62);
  const sourceDone = await exchange(source, sourceSent, { type: 'task43.source_finish', ...IDS });
  expect(sourceDone).toMatchObject({ type: 'task43.source_verified', size: SIZE, sha256: SHA256 });
  const verified = await exchange(target, targetSent, { type: 'task43.verify', ...IDS });
  expect(verified).toMatchObject({ type: 'task43.verified', size: SIZE, sha256: SHA256 });
  return exchange(target, targetSent, { type: 'task43.commit', ...IDS });
}

describe('task43 node adapter', () => {
  it('qualifies the helper and copies exact synthetic bytes between two fixture workspaces', async () => {
    const current = fixture();
    const source = await adapter(current);
    const target = await adapter(current);
    expect(source.node.capability).toBe(true);
    expect(target.node.capability).toBe(true);
    const stored = await copy(source.node, source.sent, target.node, target.sent);
    expect(stored).toMatchObject({ type: 'task43.stored', mode: 'copied', size: SIZE, sha256: SHA256, actualPath: current.final });
    expect(statSync(current.final).size).toBe(SIZE);
    expect(createHash('sha256').update(readFileSync(current.final)).digest('hex')).toBe(SHA256);
    source.node.close();
    target.node.close();

    const retry = await adapter(current);
    const ready = await exchange(retry.node, retry.sent, { type: 'task43.prepare', ...CONTEXT, role: 'target' });
    expect(ready).toMatchObject({ type: 'task43.ready', existing: 'matching' });
    const already = await exchange(retry.node, retry.sent, { type: 'task43.commit', ...IDS });
    expect(already).toMatchObject({ type: 'task43.stored', mode: 'already_present', size: SIZE, sha256: SHA256 });
    retry.node.close();
  });

  it('returns bounded failures and never overwrites a different destination', async () => {
    const current = fixture();
    writeFileSync(current.final, 'different');
    const target = await adapter(current);
    const failed = await exchange(target.node, target.sent, { type: 'task43.prepare', ...CONTEXT, role: 'target' });
    expect(failed).toMatchObject({ type: 'task43.failed', reason: 'destination_conflict', mayExist: true });
    expect(readFileSync(current.final, 'utf8')).toBe('different');
    expect(JSON.stringify(failed)).not.toContain(current.dir);
    target.node.close();
  });

  it('rejects a wrong source hash before any read frame', async () => {
    const current = fixture();
    const sent: Task43NodeMessage[] = [];
    const node = await createTask43Node({ dir: current.dir, policy: { ...POLICY, sha256: '0'.repeat(64) }, send: message => void sent.push(message) });
    const failed = await exchange(node, sent, { type: 'task43.prepare', ...CONTEXT, role: 'source' });
    expect(failed).toMatchObject({ type: 'task43.failed', reason: 'hash_mismatch', mayExist: false });
    node.close();
  });

  it('drops unnamed data on disconnect and fences later frames', async () => {
    const current = fixture();
    const target = await adapter(current);
    const ready = await exchange(target.node, target.sent, { type: 'task43.prepare', ...CONTEXT, role: 'target' });
    expect(ready).toMatchObject({ type: 'task43.ready', existing: 'absent' });
    const ack = await exchange(target.node, target.sent, { type: 'task43.write', ...IDS, offset: 0, data: DATA.subarray(0, 32768).toString('base64') });
    expect(ack.type).toBe('task43.ack');
    target.node.close();
    expect(existsSync(current.final)).toBe(false);
    const late = await exchange(target.node, target.sent, { type: 'task43.commit', ...IDS });
    expect(late).toMatchObject({ type: 'task43.failed', reason: 'io_failed' });
    expect(existsSync(current.final)).toBe(false);
  });

  it('does not advertise or execute when helper qualification fails', async () => {
    const current = fixture();
    const target = await adapter(current, { helperPath: join(current.dir, 'missing-helper.py') });
    expect(target.node.capability).toBe(false);
    const failed = await exchange(target.node, target.sent, { type: 'task43.prepare', ...CONTEXT, role: 'target' });
    expect(failed).toMatchObject({ type: 'task43.failed', reason: 'unsupported_node', mayExist: false });
    expect(existsSync(current.final)).toBe(false);
    target.node.close();
  });
});
