import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Decrypter, Encrypter } from 'age-encryption';
import { z } from 'zod';
import type { HeldCertificate } from '../keeper/certificate.js';
import type { MachineKey } from '../keeper/machine-keys.js';
import { certFacts, issuedBy } from '../network/authority.js';

/* A backup of the company as one file of three parts, so it travels as one stream and is checked before it is opened:
   this line, the head (what was signed, the signature and the signer's certificate, as one line of JSON), and the part
   sealed with age, which only the machines that hold the data and the recovery file open. */
const BUNDLE_LINE = 'hornhoof-bundle v1';
/* The first line inside the sealed part. */
const CONTENT_LINE = 'hornhoof-bundle-content v1';
/* The first line inside a challenge, which is sealed the same way and is no bundle. */
const CHALLENGE_LINE = 'hornhoof-recovery-challenge v1';
/* What stands before the manifest in what is signed, so the signature is of nothing else the key signs. */
const SIGNED_PREFIX = 'hornhoof-bundle-manifest v1\n';
export const MAX_HEAD = 65_536;
export const MAX_CHALLENGE = 1024;

/* fork: a database set aside before a merge, saved before it goes. */
export type BundleReason = 'timer' | 'update' | 'fork';
export type RecoveryLink = { name: string; url: string };
/* dumpedAt: the moment a restore brings the company back to. madeAt: when it was sealed and signed. size, sha256: of
   the sealed part. recipients: the age keys it is sealed to, the recovery key among them when there is one.
   recoveryLink: the public link that key was saved with. migrations: how many the dumped database had applied.
   signer, serial: the machine that signed and its certificate. */
export type Manifest = {
  v: 1; id: string; company: string; dumpedAt: string; madeAt: string; reason: BundleReason; size: number; sha256: string;
  recipients: string[]; recovery: string | null; recoveryLink: RecoveryLink | null; migrations: number; signer: string; serial: string;
};
export type BundleSecrets = { HORNHOOF_SECRET: string; NODE_KEY: string; RELAY_URL: string };
export type Refusal = 'format' | 'authority' | 'role' | 'time' | 'signature' | 'company' | 'size' | 'hash' | 'content' | 'key' | 'room' | 'idle';

/* Why a bundle was not taken. Its message is one of this module's own: what the age library says of a failure can quote
   the key it was given, so none of that is ever passed on, as a message or as a cause. */
export class BundleRefused extends Error {
  constructor(
    readonly reason: Refusal,
    message: string,
  ) {
    super(message);
    this.name = 'BundleRefused';
  }
}

const ManifestShape = z.strictObject({
  v: z.literal(1),
  id: z.uuid(),
  company: z.uuid(),
  dumpedAt: z.iso.datetime(),
  madeAt: z.iso.datetime(),
  reason: z.enum(['timer', 'update', 'fork']),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recipients: z.array(z.string().min(1).max(200)).min(1).max(64),
  recovery: z.string().min(1).max(200).nullable(),
  recoveryLink: z.strictObject({ name: z.string().min(1).max(200), url: z.string().min(1).max(500) }).nullable(),
  migrations: z.number().int().min(0),
  signer: z.uuid(),
  serial: z.string().regex(/^[0-9a-f]{1,64}$/),
});
const HeadShape = z.strictObject({ manifest: z.string().min(2), signature: z.string().regex(/^[A-Za-z0-9_-]+$/), certPem: z.string().min(1) });
const Secrets = z.strictObject({ HORNHOOF_SECRET: z.string(), NODE_KEY: z.string(), RELAY_URL: z.string() });
const Content = z.strictObject({ id: z.uuid(), company: z.uuid(), secrets: Secrets });

const NO_KEY = 'No key given opens this bundle.';
const BAD_CONTENT = 'What is sealed inside is not the backup its head names.';

/* The bytes of a stream as they come, for whoever reads a few lines and hands the rest on. */
type Chunks = AsyncIterator<Uint8Array>;
const chunksOf = (input: Readable): Chunks => input[Symbol.asyncIterator]() as Chunks;

/* Reads lines from the start of a stream, each no longer than its bound, and gives back what came after them. */
async function takeLines(from: Chunks, bounds: number[]): Promise<{ lines: string[]; left: Buffer } | null> {
  const lines: string[] = [];
  let held = Buffer.alloc(0);
  for (;;) {
    const end = held.indexOf(0x0a);
    if (end >= 0) {
      if (end > bounds[lines.length]!) return null;
      lines.push(held.subarray(0, end).toString('utf8'));
      held = held.subarray(end + 1);
      if (lines.length === bounds.length) return { lines, left: held };
      continue;
    }
    if (held.length > bounds[lines.length]!) return null;
    const next = await from.next();
    if (next.done) return null;
    held = Buffer.concat([held, next.value]);
  }
}

/* What was left of a stream after its first lines, and all that still comes. It can be cut at any moment, also while
   it waits for bytes that never come: cutting it cuts what it reads from. Read to its end, it leaves that open, since
   a peer's request is still to be answered on. */
function restOf(left: Buffer, from: Chunks, input: Readable, failed: () => Error): Readable {
  let first: Buffer | null = left.length > 0 ? left : null;
  let ended = false;
  return new Readable({
    read() {
      if (first) {
        const chunk = first;
        first = null;
        this.push(chunk);
        return;
      }
      from.next().then(
        next => {
          if (this.destroyed) return;
          ended = next.done === true;
          this.push(next.done ? null : next.value);
        },
        () => void (this.destroyed || this.destroy(failed())),
      );
    },
    destroy(err, done) {
      if (err || !ended) input.destroy();
      done(err);
    },
  });
}

/* BUNDLE_LINE and the head, as they stand before the sealed part. */
export const headLine = (head: string): string => `${BUNDLE_LINE}\n${head}\n`;

/* Reads the two lines a bundle starts with and hands the rest on unread. */
export async function readHead(input: Readable): Promise<{ head: string; rest: Readable }> {
  const from = chunksOf(input);
  const read = await takeLines(from, [BUNDLE_LINE.length, MAX_HEAD]).catch(() => null);
  if (!read || read.lines[0] !== BUNDLE_LINE) {
    input.destroy();
    throw new BundleRefused('format', 'This is no backup bundle of Hornhoof.');
  }
  return { head: read.lines[1]!, rest: restOf(read.left, from, input, () => new BundleRefused('format', 'The bundle broke off on its way.')) };
}

/* What a head says, once everything about it but the sealed part's size and hash holds: the certificate is the
   company's authority's, of a machine that holds the data, the very machine and certificate the manifest names, and
   valid when the bundle was made (a later expiry does not matter); the signature is that certificate's key's; and the
   company is this one, when one is asked for. */
export function checkHead(head: string, want: { authorityPem: string; company: string | null }): Manifest {
  const format = () => new BundleRefused('format', 'The head of this bundle cannot be read.');
  let said: z.infer<typeof HeadShape>;
  let manifest: Manifest;
  try {
    said = HeadShape.parse(JSON.parse(head));
    manifest = ManifestShape.parse(JSON.parse(said.manifest));
  } catch {
    throw format();
  }
  let facts: ReturnType<typeof certFacts>;
  try {
    if (!issuedBy(want.authorityPem, said.certPem)) throw new Error('another authority');
    facts = certFacts(said.certPem);
  } catch {
    throw new BundleRefused('authority', "This bundle was not signed by a machine of this company's network.");
  }
  if (facts.role !== 'data' || facts.machineId !== manifest.signer || facts.serial !== manifest.serial) {
    throw new BundleRefused('role', "This bundle was not signed by the machine that held the company's data, with the certificate it names.");
  }
  const madeAt = Date.parse(manifest.madeAt);
  if (madeAt < facts.notBefore.getTime() || madeAt > facts.notAfter.getTime()) throw new BundleRefused('time', "This bundle was made at a time its signer's certificate does not cover.");
  let signed = false;
  try {
    signed = verify(null, Buffer.from(SIGNED_PREFIX + said.manifest, 'utf8'), createPublicKey(facts.signKey), Buffer.from(said.signature, 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) throw new BundleRefused('signature', "This bundle's head is not what its signer signed.");
  if (want.company !== null && manifest.company !== want.company) throw new BundleRefused('company', "This bundle is another company's.");
  return manifest;
}

type SealOptions = {
  dump: Readable; id: string; company: string; dumpedAt: Date; now?: Date; reason: BundleReason; migrations: number; secrets: BundleSecrets;
  recipients: string[]; recovery: string | null; recoveryLink: RecoveryLink | null; key: MachineKey; held: HeldCertificate; out: string;
};

/* Seals a dump into `out`, for its owner alone, while hashing it, and signs what it made. Nothing holds the dump whole
   in memory. */
export async function sealBundle(opts: SealOptions): Promise<{ head: string; manifest: Manifest }> {
  const recipients = [...new Set([...opts.recipients, ...(opts.recovery ? [opts.recovery] : [])])].sort();
  if (recipients.length === 0) throw new Error('A bundle needs someone who can open it.');
  const first = Buffer.from(`${CONTENT_LINE}\n${JSON.stringify({ id: opts.id, company: opts.company, secrets: opts.secrets })}\n`, 'utf8');
  async function* plain() {
    yield first;
    yield* opts.dump as AsyncIterable<Uint8Array>;
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    const encrypter = new Encrypter();
    for (const recipient of recipients) encrypter.addRecipient(recipient);
    const sealed = await encrypter.encrypt(Readable.toWeb(Readable.from(plain(), { objectMode: false })) as ReadableStream<Uint8Array>);
    await pipeline(
      Readable.fromWeb(sealed as never),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(opts.out, { flags: 'wx', mode: 0o600 }),
    );
  } catch (err) {
    opts.dump.destroy();
    /* The library's own words may carry a key. */
    throw new Error(err instanceof Error && 'code' in err ? `The bundle could not be written: ${String(err.code)}.` : 'The dump could not be sealed.');
  }
  const manifest: Manifest = {
    v: 1, id: opts.id, company: opts.company, dumpedAt: opts.dumpedAt.toISOString(), madeAt: (opts.now ?? new Date()).toISOString(), reason: opts.reason,
    size, sha256: hash.digest('hex'), recipients, recovery: opts.recovery, recoveryLink: opts.recoveryLink, migrations: opts.migrations,
    signer: opts.held.machine, serial: certFacts(opts.held.certPem).serial,
  };
  const text = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(SIGNED_PREFIX + text, 'utf8'), createPrivateKey(opts.key.privatePem)).toString('base64url');
  return { head: JSON.stringify({ manifest: text, signature, certPem: opts.held.certPem }), manifest };
}

/* Opens the sealed part with the first key that fits, and checks that what is inside is the backup the manifest names
   before any of it is used: a sealed part moved under another head is refused here. The dump streams on from the third
   line. */
export async function openBundle(sealed: Readable, manifest: Manifest, identities: string[]): Promise<{ secrets: BundleSecrets; dump: Readable }> {
  let plain: Readable;
  try {
    const decrypter = new Decrypter();
    for (const identity of identities) decrypter.addIdentity(identity);
    plain = Readable.fromWeb((await decrypter.decrypt(Readable.toWeb(sealed) as ReadableStream<Uint8Array>)) as never);
  } catch {
    sealed.destroy();
    throw new BundleRefused('key', NO_KEY);
  }
  const from = chunksOf(plain);
  const read = await takeLines(from, [CONTENT_LINE.length, MAX_HEAD]).catch(() => null);
  const content = read && read.lines[0] === CONTENT_LINE ? Content.safeParse(jsonOrNull(read.lines[1]!)) : null;
  if (!read || !content?.success || content.data.id !== manifest.id || content.data.company !== manifest.company) {
    plain.destroy();
    sealed.destroy();
    throw new BundleRefused('content', BAD_CONTENT);
  }
  return { secrets: content.data.secrets, dump: restOf(read.left, from, plain, () => new BundleRefused('content', 'The sealed part broke off before its end.')) };
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;

/* What a machine that survived sends a server it does not know, to learn whether that server holds the recovery file:
   sealed to the recovery key, the link's name and a number used once. */
export async function makeChallenge(recipient: string, linkName: string): Promise<{ file: Uint8Array; nonce: string }> {
  const nonce = randomBytes(32).toString('base64url');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return { file: await encrypter.encrypt(Buffer.from(`${CHALLENGE_LINE}\n${linkName}\n${nonce}`, 'utf8')), nonce };
}

/* The number inside a challenge, for the server that holds the recovery file and is asked under this link's name;
   nothing for anything else. Its size is looked at before anything is opened, so a bundle never passes as one. */
export async function answerChallenge(file: Uint8Array, identity: string, linkName: string): Promise<string | null> {
  if (file.length > MAX_CHALLENGE) return null;
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const lines = (await decrypter.decrypt(file, 'text')).split('\n');
    return lines.length === 3 && lines[0] === CHALLENGE_LINE && lines[1] === linkName && NONCE.test(lines[2]!) ? lines[2]! : null;
  } catch {
    return null;
  }
}

const proof = (nonce: string, words: string): string => createHmac('sha256', Buffer.from(nonce, 'base64url')).update(words).digest('base64url');

/* What the server answers a challenge with: made from the number, and not the number. */
export const answerProof = (nonce: string): string => proof(nonce, 'hornhoof-recovery-answer');
/* What each bundle sent after the challenge carries: made from the number and that bundle's id, so whoever carries
   both proofs can send no other bundle with them. */
export const uploadProof = (nonce: string, id: string): string => proof(nonce, `hornhoof-recovery-upload\n${id}`);
