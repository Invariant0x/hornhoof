import { createPublicKey, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api';
import { deviceKey, forgetOwnerKey, keyDefaults, makeKey, serverKey, unlockKey, withOwnerKey, type StoredKey } from '../src/owner-key';
import { mockApi, TEST_KEY } from './api-mock';

const { subtle } = webcrypto;
const bytes = (text: string) => Buffer.from(text, 'base64url');
const JOIN = 'curl -fsSL https://corp.hornhoof.test/install.sh | bash -s -- --join abc';

type Sent = { password: string; publicKey: string; wrapped: string; salt: string; iv: string; iterations: number };

/* Opens what the server would keep, with a password: the private half, or a failure with any other password. */
async function unwrap(sent: Sent, password: string): Promise<CryptoKey> {
  const typed = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const wrapping = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(sent.salt), iterations: sent.iterations }, typed, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
  return subtle.unwrapKey('pkcs8', bytes(sent.wrapped), wrapping, { name: 'AES-GCM', iv: bytes(sent.iv) }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
}

describe("a person's own key in the browser", () => {
  it('makes a key the server keeps only wrapped', async () => {
    const calls = mockApi({});
    const made = await makeKey('correct horse battery');
    const put = calls.filter(call => call.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]!.path).toBe('/api/me/key');
    const sent = put[0]!.body as Sent;
    expect(Object.keys(sent).sort()).toEqual(['iterations', 'iv', 'password', 'publicKey', 'salt', 'wrapped']);
    expect(sent).toMatchObject({ password: 'correct horse battery', publicKey: made.publicKey, iterations: 1000 });
    /* The public half is a P-256 key the server reads, of the length a join command carries. */
    const read = createPublicKey({ key: bytes(sent.publicKey), format: 'der', type: 'spki' });
    expect(read.asymmetricKeyDetails).toMatchObject({ namedCurve: 'prime256v1' });
    expect(sent.publicKey).toMatch(/^[A-Za-z0-9_-]{122}$/);
    expect(bytes(sent.salt)).toHaveLength(16);
    expect(bytes(sent.iv)).toHaveLength(12);
    /* What the server keeps opens with that password and with no other. */
    expect((await unwrap(sent, 'correct horse battery')).type).toBe('private');
    await expect(unwrap(sent, 'another password')).rejects.toThrow();

    /* On this device the private half signs and cannot be read out. */
    const kept = await keyDefaults.store.get();
    expect(kept!.publicKey).toBe(made.publicKey);
    expect(kept!.privateKey.extractable).toBe(false);
    expect(kept!.privateKey.usages).toEqual(['sign']);
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kept!.privateKey as webcrypto.CryptoKey, new TextEncoder().encode('grant'));
    const publicHalf = await subtle.importKey('spki', bytes(sent.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicHalf, signature, new TextEncoder().encode('grant'))).toBe(true);
  });

  it('keeps nothing when the server refuses the key', async () => {
    mockApi({ 'PUT /api/me/key': [401, { error: { code: 'unauthorized', message: 'Wrong email or password.', reason: 'wrong_password' } }] });
    await expect(makeKey('wrong')).rejects.toMatchObject({ status: 401, reason: 'wrong_password' });
    expect(await keyDefaults.store.get()).toBeNull();
  });

  it("reads the server's key, or none", async () => {
    mockApi({});
    expect(await serverKey()).toEqual(TEST_KEY);
    mockApi({ 'GET /api/me/key': [200, { key: null }] });
    expect(await serverKey()).toBeNull();
  });

  it("drops a key that is not the server's", async () => {
    mockApi({});
    const mine = await makeKey('correct horse battery');
    const sameOnServer = { ...TEST_KEY, publicKey: mine.publicKey };
    expect(await deviceKey(sameOnServer)).toBe(mine.privateKey);
    expect(await keyDefaults.store.get()).not.toBeNull();
    /* The server holds another key now, as after a reset of the password. */
    expect(await deviceKey(TEST_KEY)).toBeNull();
    expect(await keyDefaults.store.get()).toBeNull();
    /* And with no key on the server, one this device kept is nobody's. */
    await makeKey('correct horse battery');
    expect(await deviceKey(null)).toBeNull();
    expect(await keyDefaults.store.get()).toBeNull();
  });

  it('forgets the key when the session ends, and not for a wrong password', async () => {
    mockApi({});
    await makeKey('correct horse battery');
    mockApi({ 'GET /api/x': [401, { error: { code: 'unauthorized', message: 'Wrong email or password.', reason: 'wrong_password' } }] });
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 401 });
    expect(await keyDefaults.store.get()).not.toBeNull();
    mockApi({ 'GET /api/x': [401, { error: { code: 'unauthorized', message: 'Sign in to continue.', reason: 'signed_out' } }] });
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 401, reason: 'signed_out' });
    expect(await keyDefaults.store.get()).toBeNull();
    await makeKeyAgain();
    await forgetOwnerKey();
    expect(await keyDefaults.store.get()).toBeNull();
  });

  it('adds the key to a join command only', () => {
    expect(withOwnerKey(JOIN, 'KEY')).toBe(`${JOIN} --owner-key KEY`);
    expect(withOwnerKey(`${JOIN} --owner-key OLD`, 'KEY')).toBe(`${JOIN} --owner-key OLD`);
    const update = 'curl -fsSL https://corp.hornhoof.test/install.sh | bash';
    expect(withOwnerKey(update, 'KEY')).toBe(update);
  });
});

async function makeKeyAgain(): Promise<void> {
  mockApi({});
  await makeKey('correct horse battery');
}

describe('the key on another device, and what it signs', () => {
  /* The key as the server keeps it after the browser made it, and nothing of it on this device: another device. */
  async function elsewhere(password: string): Promise<StoredKey> {
    const calls = mockApi({});
    await makeKey(password);
    const sent = calls.find(call => call.method === 'PUT')!.body as Sent;
    await keyDefaults.store.clear();
    return { publicKey: sent.publicKey, wrapped: sent.wrapped, salt: sent.salt, iv: sent.iv, iterations: sent.iterations };
  }

  it('unlocks with the password only', async () => {
    const stored = await elsewhere('correct horse battery');
    expect(await unlockKey(stored, 'another password')).toBeNull();
    expect(await keyDefaults.store.get()).toBeNull();
    const key = await unlockKey(stored, 'correct horse battery');
    expect(key).not.toBeNull();
    /* It stays on this device as a key that signs and cannot be read out, and is the server's own. */
    const kept = await keyDefaults.store.get();
    expect(kept).toMatchObject({ publicKey: stored.publicKey });
    expect([kept!.privateKey.extractable, kept!.privateKey.usages]).toEqual([false, ['sign']]);
    expect(await deviceKey(stored)).toBe(kept!.privateKey);
  });
});
