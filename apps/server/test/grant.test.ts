import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRANT_MAX_S, readGrant, type Grant } from '../src/modules/computer/grant.js';

const { subtle } = webcrypto;
const b64 = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const MACHINE = 'a'.repeat(64);
const NOW = 1_800_000_000;

/* A key and a grant as the browser makes them: ECDSA P-256 with SHA-256, the signature in its 64 bytes. */
async function owner() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64(await subtle.exportKey('spki', pair.publicKey));
  const sign = async (payload: string): Promise<Grant> => ({ payload, signature: b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload))) });
  const grant = (over: Record<string, unknown> = {}) => sign(JSON.stringify({ v: 1, machine: MACHINE, until: NOW + 86_400, at: NOW, nonce: b64(webcrypto.getRandomValues(new Uint8Array(16))), ...over }));
  return { publicKey, sign, grant, pair };
}

describe("a grant of a machine's owner", () => {
  it('reads a grant as the browser signs it', async () => {
    const me = await owner();
    const grant = await me.grant();
    const facts = readGrant(grant, me.publicKey, MACHINE, NOW);
    expect(facts).toMatchObject({ v: 1, machine: MACHINE, until: NOW + 86_400, at: NOW });
    expect(facts!.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    /* It stands until its end, and its end may be the skew past a day. */
    expect(readGrant(grant, me.publicKey, MACHINE, NOW + 86_399)).not.toBeNull();
    expect(readGrant(await me.grant({ until: NOW + GRANT_MAX_S }), me.publicKey, MACHINE, NOW)).not.toBeNull();
    /* A clock a little behind the browser's takes it too. */
    expect(readGrant(grant, me.publicKey, MACHINE, NOW - 300)).not.toBeNull();
  });

  it('reads nothing that its owner did not sign for this machine and this day', async () => {
    const me = await owner();
    const other = await owner();
    const good = await me.grant();
    const changed = (text: string) => (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
    const bad: [string, Grant, string?, string?, number?][] = [
      ['a payload that was changed', { ...good, payload: good.payload.replace('"v":1', '"v":1 ') }],
      ['a signature that was changed', { ...good, signature: changed(good.signature) }],
      ["another person's key", good, other.publicKey],
      ['another machine', good, me.publicKey, 'b'.repeat(64)],
      ['a sixth field', await me.grant({ more: 1 })],
      ['a missing field', await me.sign(JSON.stringify({ v: 1, machine: MACHINE, until: NOW + 60, at: NOW }))],
      ['another version', await me.grant({ v: 2 })],
      ['a short nonce', await me.grant({ nonce: 'x'.repeat(21) })],
      ['an end past a day and the skew', await me.grant({ until: NOW + GRANT_MAX_S + 1 })],
      ['an end that has passed', good, me.publicKey, MACHINE, NOW + 86_400],
      ['a start too far ahead', await me.grant({ at: NOW + 301, until: NOW + 600 })],
      ['a time that is no whole number', await me.grant({ until: NOW + 0.5 })],
      ['a payload that is no object', await me.sign('[1]')],
      ['a payload that is no JSON', await me.sign('until tomorrow')],
      ['a key that is none', good, 'not a key'],
      ['a signature that is not base64url', { ...good, signature: `${good.signature.slice(0, -1)}$` }],
    ];
    for (const [name, grant, key = me.publicKey, machine = MACHINE, now = NOW] of bad) expect(readGrant(grant, key, machine, now), name).toBeNull();
    /* A signature in DER, as other tools write it, is not the browser's. */
    const { createSign } = await import('node:crypto');
    const der = createSign('sha256').update(good.payload).sign({ key: Buffer.from(await subtle.exportKey('pkcs8', me.pair.privateKey)), format: 'der', type: 'pkcs8' }).toString('base64url');
    expect(readGrant({ payload: good.payload, signature: der }, me.publicKey, MACHINE, NOW)).toBeNull();
  });
});
