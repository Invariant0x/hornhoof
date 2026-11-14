import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PUBLICATION, REPLICA_ROLE, replicaPassword, scramVerifier } from '../src/modules/keeper/replica.js';

const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();
const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((byte, at) => byte ^ b[at]!));

describe("the role a copy reads the company's database with", () => {
  it('has a password every data machine can tell and none stores', () => {
    const secret = Buffer.alloc(32, 7);
    const password = replicaPassword(secret);
    expect(password).toBe(createHmac('sha256', secret).update('hornhoof-replica').digest('base64url'));
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replicaPassword(Buffer.alloc(32, 8))).not.toBe(password);
    expect([REPLICA_ROLE, PUBLICATION]).toEqual(['hornhoof_replica', 'hornhoof']);
  });

  it('makes the verifier Postgres keeps for a password', () => {
    /* The exchange of RFC 7677, section 3: the user's password is "pencil". */
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramVerifier('pencil', salt);
    const [head, keys] = verifier.split('$').slice(1) as [string, string];
    expect(verifier.startsWith('SCRAM-SHA-256$4096:')).toBe(true);
    expect(head).toBe('4096:W22ZaJ0SNY7soEsUEjb6gQ==');
    const [storedKey, serverKey] = keys.split(':').map(part => Buffer.from(part, 'base64')) as [Buffer, Buffer];
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const message = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    /* The server's signature of that exchange, and the client's proof, which opens to a key whose hash is the stored one. */
    expect(hmac(serverKey, message).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    const clientKey = xor(Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64'), hmac(storedKey, message));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
    /* A salt of its own each time, 16 bytes. */
    const [first, second] = [scramVerifier('pencil'), scramVerifier('pencil')];
    expect(first).not.toBe(second);
    expect(Buffer.from(first.split('$')[1]!.split(':')[1]!, 'base64')).toHaveLength(16);
  });
});
