import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { describe, expect, it, onTestFinished } from 'vitest';
import { Becoming, REPLICA_FILE, ROLE_FAILED, ROLE_FILE, ROLE_RETRY_MS } from '../src/modules/keeper/become.js';

const SECRETS = { HORNHOOF_SECRET: Buffer.alloc(32, 7).toString('base64'), NODE_KEY: 'n'.repeat(44), RELAY_URL: 'https://relay.hornhoof.test' };
const FAILED_LINE = "The company's settings cannot be written here, so this machine stays a worker.";

async function sealedTo(recipient: string, secrets: object = SECRETS): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return Buffer.from(await encrypter.encrypt(JSON.stringify(secrets))).toString('base64');
}

async function stand(over: { role?: 'data' | 'worker'; answer?: () => Promise<{ status: number; body: unknown }> } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-become-'));
  onTestFinished(() => rmSync(controlDir, { recursive: true, force: true }));
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const state = { held: over.role ?? 'data', now: new Date('2026-11-11T12:00:00Z'), asked: [] as string[], renewed: 0, lines: [] as string[] };
  const answer = over.answer ?? (async () => ({ status: 200, body: { sealed: await sealedTo(recipient) } }));
  const becoming = new Becoming({
    controlDir,
    ask: async (method, path) => (state.asked.push(`${method} ${path}`), answer()),
    heldRole: () => state.held,
    renew: () => void (state.renewed += 1),
    age: async () => ({ identity }),
    log: line => state.lines.push(line),
    now: () => state.now,
  });
  const has = (name: string) => existsSync(join(controlDir, name));
  const later = (ms: number) => void (state.now = new Date(state.now.getTime() + ms));
  return { becoming, controlDir, state, recipient, has, later };
}

describe('a worker that is given the data', () => {
  it('asks for a data certificate first', async () => {
    const s = await stand({ role: 'worker' });
    expect(await s.becoming.step({ role: 'data' })).toBe('renewing');
    expect(s.state.renewed).toBe(1);
    expect(s.state.asked).toEqual([]);
    expect(s.has(ROLE_FILE) || s.has(REPLICA_FILE)).toBe(false);
    /* Once it holds one, it asks. */
    s.state.held = 'data';
    expect(await s.becoming.step({ role: 'data' })).toBe('asked');
    expect(s.state.asked).toEqual(['POST /api/network/secrets']);
  });

  it('writes the marker before the request', async () => {
    const s = await stand();
    expect(await s.becoming.step({ role: 'data' })).toBe('asked');
    const marker = JSON.parse(readFileSync(join(s.controlDir, REPLICA_FILE), 'utf8')) as { since: string };
    expect(marker).toEqual({ since: '2026-11-11T12:00:00.000Z' });
    const request = JSON.parse(readFileSync(join(s.controlDir, ROLE_FILE), 'utf8')) as { id: string; secrets: object };
    expect(request.secrets).toEqual(SECRETS);
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(s.controlDir, ROLE_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.controlDir, REPLICA_FILE)).mode & 0o777).toBe(0o644);
    /* The marker is the older of the two, so the updater never finds the request without it. */
    expect(statSync(join(s.controlDir, REPLICA_FILE)).mtimeMs).toBeLessThanOrEqual(statSync(join(s.controlDir, ROLE_FILE)).mtimeMs);
    for (const line of s.state.lines) for (const secret of [SECRETS.HORNHOOF_SECRET, SECRETS.NODE_KEY]) expect(line).not.toContain(secret);
  });

  it('asks once', async () => {
    const s = await stand();
    writeFileSync(join(s.controlDir, ROLE_FILE), '{}');
    expect(await s.becoming.step({ role: 'data' })).toBe('idle');
    rmSync(join(s.controlDir, ROLE_FILE));
    writeFileSync(join(s.controlDir, REPLICA_FILE), '{}');
    expect(await s.becoming.step({ role: 'data' })).toBe('idle');
    expect(s.state.asked).toEqual([]);
    expect(s.state.renewed).toBe(0);
  });

  it('does nothing for a worker', async () => {
    const s = await stand();
    expect(await s.becoming.step({ role: 'worker' })).toBe('idle');
    expect(s.state.asked).toEqual([]);
    expect(s.has(ROLE_FILE) || s.has(REPLICA_FILE)).toBe(false);
  });

  it('waits an hour after a failure', async () => {
    const s = await stand();
    writeFileSync(join(s.controlDir, ROLE_FAILED), `${FAILED_LINE}\n`);
    expect(s.becoming.failure()).toBeNull();
    expect(await s.becoming.step({ role: 'data' })).toBe('failed');
    expect(s.has(ROLE_FAILED)).toBe(false);
    expect(s.becoming.failure()).toBe(FAILED_LINE);
    s.later(30 * 60_000);
    expect(await s.becoming.step({ role: 'data' })).toBe('failed');
    expect(s.state.asked).toEqual([]);
    expect([ROLE_RETRY_MS, REPLICA_FILE]).toEqual([3_600_000, 'replica.json']);
    s.later(31 * 60_000);
    expect(await s.becoming.step({ role: 'data' })).toBe('asked');
    expect(s.becoming.failure()).toBeNull();
  });

  it('takes no secrets that could not stand in the settings, and tries again with the next view', async () => {
    const answers: { status: number; body: unknown }[] = [{ status: 503, body: {} }, { status: 200, body: { sealed: 'not age' } }];
    const s = await stand({ answer: async () => answers.shift() ?? { status: 200, body: {} } });
    answers.push({ status: 200, body: { sealed: await sealedTo(s.recipient, { ...SECRETS, HORNHOOF_SECRET: 'short' }) } });
    answers.push({ status: 200, body: { sealed: await sealedTo(s.recipient, { ...SECRETS, RELAY_URL: 'https://relay.hornhoof.test\nX=1' }) } });
    answers.push({ status: 200, body: { sealed: await sealedTo(await identityToRecipient(await generateX25519Identity())) } });
    /* A server with no node key says an empty one, and that is taken. */
    answers.push({ status: 200, body: { sealed: await sealedTo(s.recipient, { ...SECRETS, NODE_KEY: '' }) } });
    for (let tries = 0; tries < 5; tries++) {
      expect(await s.becoming.step({ role: 'data' })).toBe('idle');
      expect(s.has(ROLE_FILE) || s.has(REPLICA_FILE)).toBe(false);
    }
    expect(s.state.lines).toHaveLength(5);
    for (const line of s.state.lines) expect(line).not.toContain(SECRETS.NODE_KEY);
    expect(await s.becoming.step({ role: 'data' })).toBe('asked');
    expect((JSON.parse(readFileSync(join(s.controlDir, ROLE_FILE), 'utf8')) as { secrets: { NODE_KEY: string } }).secrets.NODE_KEY).toBe('');
  });
});
