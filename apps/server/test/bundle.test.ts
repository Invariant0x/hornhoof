import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import * as age from 'age-encryption';
import { describe, expect, it, vi } from 'vitest';
import {
  answerChallenge, answerProof, BundleRefused, checkHead, headLine, makeChallenge, MAX_CHALLENGE, openBundle, readHead, sealBundle, uploadProof,
  type BundleSecrets, type Manifest,
} from '../src/modules/backups/bundle.js';
import { BundleStore } from '../src/modules/backups/store.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, type Authority } from '../src/modules/network/authority.js';

const COMPANY = randomUUID();
const SECRETS: BundleSecrets = { HORNHOOF_SECRET: randomBytes(32).toString('base64'), NODE_KEY: randomBytes(32).toString('base64'), RELAY_URL: 'https://hornhoof.org' };
const LINK = { name: 'acme', url: 'https://acme.hornhoof.org' };
const folder = () => mkdtempSync(join(tmpdir(), 'hh-bundle-'));

function machineKey(): MachineKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

/* A machine of the company with its key and the certificate its authority gave it. */
async function machine(authority: Authority, role: 'data' | 'worker', now = new Date()): Promise<{ key: MachineKey; held: HeldCertificate }> {
  const key = machineKey();
  const id = randomUUID();
  const issued = await issueCertificate(authority, { machineId: id, role, signKey: key.publicPem, now });
  return { key, held: { machine: id, role, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() } };
}

async function ageKey() {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/* The company's authority, its data machine, a worker, and the keys a bundle is sealed to. */
async function company() {
  const authority = await makeAuthority(COMPANY);
  const [data, worker, own, recovery, holder] = [await machine(authority, 'data'), await machine(authority, 'worker'), await ageKey(), await ageKey(), await ageKey()];
  const dir = folder();
  const seal = async (over: Partial<Parameters<typeof sealBundle>[0]> = {}, dump: Buffer = randomBytes(64 * 1024)) => {
    const id = over.id ?? randomUUID();
    const out = over.out ?? join(dir, `${id}.age`);
    const sealed = await sealBundle({
      dump: Readable.from([dump]), id, company: COMPANY, dumpedAt: new Date('2026-11-10T08:00:00.000Z'), reason: 'timer', migrations: 61, secrets: SECRETS,
      recipients: [own.recipient], recovery: recovery.recipient, recoveryLink: LINK, key: data.key, held: data.held, out, ...over,
    });
    return { id, out, dump, ...sealed };
  };
  return { authority, data, worker, own, recovery, holder, dir, seal };
}

const want = (c: { authority: Authority }, companyId: string | null = COMPANY) => ({ authorityPem: c.authority.certPem, company: companyId });
const reasonOf = async (work: () => unknown): Promise<string> => {
  try {
    await work();
  } catch (err) {
    return err instanceof BundleRefused ? err.reason : `not refused: ${String(err)}`;
  }
  return 'accepted';
};

describe('a backup bundle', () => {
  it('seals, checks and opens a bundle', async () => {
    const c = await company();
    const dump = randomBytes(3 * 1024 * 1024);
    const sealed = await c.seal({}, dump);
    const manifest = checkHead(sealed.head, want(c));
    expect(manifest).toEqual(sealed.manifest);
    expect(manifest).toMatchObject({
      v: 1, id: sealed.id, company: COMPANY, reason: 'timer', migrations: 61, dumpedAt: '2026-11-10T08:00:00.000Z',
      signer: c.data.held.machine, recovery: c.recovery.recipient, recoveryLink: LINK, recipients: [c.own.recipient, c.recovery.recipient].sort(),
    });
    expect(manifest.serial).toMatch(/^[0-9a-f]+$/);
    /* The size and the hash are of the sealed part, which only its owner reads. */
    const sealedPart = readFileSync(sealed.out);
    expect(statSync(sealed.out).mode & 0o777).toBe(0o600);
    expect([sealedPart.length, createHash('sha256').update(sealedPart).digest('hex')]).toEqual([manifest.size, manifest.sha256]);
    expect(sealedPart.includes(dump.subarray(0, 64))).toBe(false);
    for (const identity of [c.own.identity, c.recovery.identity]) {
      const opened = await openBundle(createReadStream(sealed.out), manifest, [identity]);
      expect(opened.secrets).toEqual(SECRETS);
      expect((await buffer(opened.dump)).equals(dump)).toBe(true);
    }
    /* A head may be checked for any company, as a server with no database yet does. */
    expect(checkHead(sealed.head, want(c, null)).id).toBe(sealed.id);
  });

  it('seals to nobody at all only by refusing', async () => {
    const c = await company();
    await expect(c.seal({ recipients: [], recovery: null })).rejects.toThrow('A bundle needs someone who can open it.');
  });

  it('a holder cannot open it, and never shows a key it cannot read', async () => {
    const c = await company();
    const sealed = await c.seal();
    expect(await reasonOf(() => openBundle(createReadStream(sealed.out), sealed.manifest, [c.holder.identity]))).toBe('key');
    /* An identity with one character changed: nothing said of it carries any stretch of the key. */
    const broken = c.own.identity.slice(0, 30) + (c.own.identity[30] === 'Q' ? 'P' : 'Q') + c.own.identity.slice(31);
    const said: string[] = [];
    for (const spied of ['log', 'error', 'warn'] as const) vi.spyOn(console, spied).mockImplementation((...args: unknown[]) => void said.push(args.join(' ')));
    try {
      await openBundle(createReadStream(sealed.out), sealed.manifest, [broken]);
    } catch (err) {
      said.push((err as Error).message, (err as Error).stack ?? '', String((err as Error).cause ?? ''));
    }
    const challenge = await makeChallenge(c.own.recipient, 'acme');
    expect(await answerChallenge(challenge.file, broken, 'acme')).toBeNull();
    vi.restoreAllMocks();
    const stretches = Array.from({ length: broken.length - 20 }, (_, at) => broken.slice(at, at + 20));
    expect(said.filter(line => stretches.some(stretch => line.includes(stretch)))).toEqual([]);
  });

  it('refuses what it must not open', async () => {
    const c = await company();
    const sealed = await c.seal();
    const head = JSON.parse(sealed.head) as { manifest: string; signature: string; certPem: string };
    const rehead = (over: object) => JSON.stringify({ ...head, ...over });
    /* The manifest's own words, with one of them changed. */
    expect(await reasonOf(() => checkHead(rehead({ manifest: head.manifest.replace('"migrations":61', '"migrations":62') }), want(c)))).toBe('signature');
    expect(await reasonOf(() => checkHead(rehead({ signature: head.signature.slice(0, -2) + (head.signature.endsWith('AA') ? 'BB' : 'AA') }), want(c)))).toBe('signature');
    /* A worker signs no bundle. */
    const byWorker = await c.seal({ key: c.worker.key, held: c.worker.held });
    expect(await reasonOf(() => checkHead(byWorker.head, want(c)))).toBe('role');
    /* Another machine's certificate over this signer's name. */
    const other = await machine(c.authority, 'data');
    expect(await reasonOf(() => checkHead(rehead({ certPem: other.held.certPem }), want(c)))).toBe('role');
    /* Another company's authority. */
    const strangers = await makeAuthority(randomUUID());
    expect(await reasonOf(() => checkHead(sealed.head, { authorityPem: strangers.certPem, company: COMPANY }))).toBe('authority');
    /* Signed at a time its certificate does not hold. */
    const later = await machine(c.authority, 'data', new Date(Date.now() + 3 * 3_600_000));
    const early = await c.seal({ key: later.key, held: later.held });
    expect(await reasonOf(() => checkHead(early.head, want(c)))).toBe('time');
    expect(await reasonOf(() => checkHead(sealed.head, want(c, randomUUID())))).toBe('company');
    for (const bad of ['', 'not json', '[]', JSON.stringify({ manifest: '{}', signature: 'x', certPem: head.certPem })]) expect(await reasonOf(() => checkHead(bad, want(c))), bad).toBe('format');

    /* A second line too long to be a head, read from a stream. */
    expect(await reasonOf(() => readHead(Readable.from([Buffer.from(`hornhoof-bundle v1\n${'x'.repeat(70_000)}\n`)])))).toBe('format');
    expect(await reasonOf(() => readHead(Readable.from([Buffer.from(`another file\n${sealed.head}\n`)])))).toBe('format');

    /* The sealed part of another bundle under this head: its hash is not the one that was signed. */
    const b = await c.seal();
    const store = new BundleStore(folder());
    const swapped = Readable.from([Buffer.from(headLine(sealed.head)), readFileSync(b.out)]);
    expect(await reasonOf(() => store.take(swapped, head_ => checkHead(head_, want(c))))).toMatch(/^(hash|size)$/);
    /* A sealed part that names another bundle inside, under a manifest that fits its size and hash. */
    const inside = await c.seal({ id: b.id, out: join(folder(), 'inside.age') });
    const forged: Manifest = { ...sealed.manifest, size: inside.manifest.size, sha256: inside.manifest.sha256 };
    expect(await reasonOf(() => openBundle(createReadStream(inside.out), forged, [c.own.identity]))).toBe('content');
    expect(await reasonOf(() => openBundle(createReadStream(inside.out), { ...inside.manifest, company: randomUUID() }, [c.own.identity]))).toBe('content');
  });

  it('answers only its own challenge', async () => {
    const c = await company();
    const challenge = await makeChallenge(c.recovery.recipient, 'acme');
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.file.length).toBeLessThanOrEqual(MAX_CHALLENGE);
    expect(await answerChallenge(challenge.file, c.recovery.identity, 'acme')).toBe(challenge.nonce);
    expect(await answerChallenge(challenge.file, c.recovery.identity, 'other')).toBeNull();
    expect(await answerChallenge(challenge.file, c.own.identity, 'acme')).toBeNull();
    /* Too long to be a challenge: refused before anything is opened. */
    const decrypt = vi.spyOn(age.Decrypter.prototype, 'decrypt');
    expect(await answerChallenge(new Uint8Array(MAX_CHALLENGE + 1), c.recovery.identity, 'acme')).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    decrypt.mockRestore();
    /* A bundle never passes as a challenge, nor a challenge as a bundle. */
    const tiny = await c.seal({ recipients: [c.recovery.recipient] }, Buffer.alloc(0));
    expect(await answerChallenge(readFileSync(tiny.out), c.recovery.identity, 'acme')).toBeNull();
    expect(await reasonOf(() => openBundle(Readable.from([Buffer.from(challenge.file)]), tiny.manifest, [c.recovery.identity]))).toBe('content');
    /* What the server answers, and what each bundle sent after it carries: none is the nonce, and none another. */
    const proofs = [answerProof(challenge.nonce), uploadProof(challenge.nonce, tiny.id), uploadProof(challenge.nonce, randomUUID())];
    expect(new Set([...proofs, challenge.nonce]).size).toBe(4);
    for (const proof of proofs) expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
