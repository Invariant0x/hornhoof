import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { personKeys } from '../src/db/schema.js';
import { isP256, KEY_ITERATIONS, keyPrint } from '../src/modules/computer/owner-key.js';
import { as, invitePerson, SETUP, setUpCompany, testApp } from './helpers.js';

const { subtle } = webcrypto;
const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');

/* A key as the browser makes it: an ECDSA P-256 pair whose private half is wrapped with a key made from the password. */
async function browserKey(password: string, iterations = KEY_ITERATIONS, curve = 'P-256') {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  /* Few rounds here: the server never derives the key, it only keeps what it is given. */
  const wrapping = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
  const wrapped = await subtle.wrapKey('pkcs8', pair.privateKey, wrapping, { name: 'AES-GCM', iv });
  return { publicKey: b64(await subtle.exportKey('spki', pair.publicKey)), wrapped: b64(wrapped), salt: b64(salt), iv: b64(iv), iterations };
}

describe("a person's own key", () => {
  it('is kept only wrapped, and taken only with their password', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const get = (who: object = as(ceo)) => app.inject({ url: '/api/me/key', ...who });
    const put = (payload: object, who: object = as(ceo)) => app.inject({ method: 'PUT', url: '/api/me/key', payload, ...who });
    expect((await get()).json()).toEqual({ key: null });
    const key = await browserKey(SETUP.password);

    const wrong = await put({ password: 'not the password', ...key });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toMatchObject({ reason: 'wrong_password' });
    /* A key the browser made with too few rounds, of another curve or that is no key at all is not taken. */
    for (const bad of [{ ...key, iterations: 1000 }, { ...key, iterations: 3_000_000_000 }, await browserKey(SETUP.password, KEY_ITERATIONS, 'P-384'), { ...key, publicKey: 'not a key' }, { ...key, wrapped: 'x'.repeat(5000) }, { ...key, salt: undefined }]) {
      expect((await put({ password: SETUP.password, ...bad })).statusCode).toBe(400);
    }
    expect(await db.select().from(personKeys)).toEqual([]);

    expect((await put({ password: SETUP.password, ...key })).statusCode).toBe(204);
    expect((await get()).json()).toEqual({ key });
    const [row] = await db.select().from(personKeys);
    expect(JSON.stringify(row)).not.toContain(SETUP.password);
    /* The key is made once: a second one would leave machines with a pin nobody holds the key of. */
    const second = await put({ password: SETUP.password, ...(await browserKey(SETUP.password)) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toEqual({ code: 'conflict', message: 'You have a key already.', reason: 'key_exists' });
    expect((await get()).json()).toEqual({ key });
  });

  it("is each person's own, and nobody's without their session", async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const key = await browserKey('correct horse battery');
    expect((await app.inject({ method: 'PUT', url: '/api/me/key', payload: { password: 'correct horse battery', ...key }, ...as(maria) })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/me/key', ...as(ceo) })).json()).toEqual({ key: null });
    expect((await app.inject({ url: '/api/me/key', ...as(maria) })).json()).toEqual({ key });
    expect((await app.inject({ url: '/api/me/key' })).statusCode).toBe(401);
  });

  it('has a print, and is a P-256 key or none', async () => {
    const key = await browserKey('x');
    expect(keyPrint(key.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyPrint(key.publicKey)).toBe(keyPrint(key.publicKey));
    expect(keyPrint((await browserKey('x')).publicKey)).not.toBe(keyPrint(key.publicKey));
    expect(key.publicKey).toHaveLength(122);
    expect(isP256(key.publicKey)).toBe(true);
    const ed25519 = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    for (const other of [ed25519, (await browserKey('x', KEY_ITERATIONS, 'P-384')).publicKey, 'not a key', '', `${key.publicKey}$`, `${key.publicKey}=`]) expect(isP256(other), other).toBe(false);
  });
});
