import { timingSafeEqual } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { guard, limiter } from '../../auth/limit.js';
import { clientAddress } from '../../auth/tunnel.js';
import { ApiError } from '../../errors.js';
import { RECOVERY_PROOF, UUID } from '../../net/proxy.js';
import { isSetupCode, setupNeeded } from '../setup/code.js';
import { answerChallenge, answerProof, BundleRefused, checkHead, MAX_CHALLENGE, uploadProof } from './bundle.js';
import { parseRecoveryFile, type RecoveryFile } from './recovery.js';
import { BundleStore } from './store.js';
import { RECOVERY_LINK, type RestoreStatus } from './types.js';

/* The link of the recovery file goes into the control folder, for the keeper's link child while the database has none.
   It holds the link's key, so only this container's user reads it. */
export { RECOVERY_LINK } from './types.js';
/* For how long a challenge that was answered lets its bundles in, from its first answer. */
export const NONCE_MS = 3_600_000;
export const UPLOADS_AT_ONCE = 2;
/* Where the bundles lie that were sent for the restore, which the server's keeper reads. */
const INCOMING = ['restore', 'incoming'];
/* A recovery file is a comment line and one line of JSON. */
const MAX_FILE = 16 * 1024;
/* How many answered challenges are remembered; past it the oldest are let go. */
const NONCES_KEPT = 10_000;

export type RecoveryView = {
  company: string;
  link: string | null;
  bundles: { id: string; dumpedAt: string; reason: string; size: number; from: string }[];
  restore: RestoreStatus | null;
};

const sameText = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* A server set up anew after the old one was lost, before it has a company: whoever has its setup code gives it the
   recovery file, the machines that survived find it by a challenge only that file answers and send it their bundles,
   and the CEO picks one to restore. The file lives in memory alone; nothing of its private half is ever written. */
export class TotalLoss {
  private file: RecoveryFile | null = null;
  /* Each challenge that was answered, by its number, with the time of its first answer. */
  private readonly answered = new Map<string, number>();
  private store: BundleStore | null = null;
  private uploads = 0;

  constructor(
    private readonly ctx: Ctx,
    private readonly now: () => Date = () => new Date(Date.now()),
  ) {}

  /* Another file than the one before takes its place, and what was taken for that one goes. */
  begin(file: RecoveryFile): void {
    if (this.file && this.file.identity !== file.identity) {
      this.answered.clear();
      this.incoming().keepOnly([]);
    }
    this.file = file;
    const path = join(this.ctx.config.controlDir, RECOVERY_LINK);
    if (!file.link) return rmSync(path, { force: true });
    writeFileSync(`${path}.new`, JSON.stringify(file.link), { mode: 0o600 });
    renameSync(`${path}.new`, path);
  }

  /* A company exists: there is nothing to recover any more. */
  end(): void {
    this.file = null;
    this.answered.clear();
    rmSync(join(this.ctx.config.controlDir, RECOVERY_LINK), { force: true });
  }

  active(): RecoveryFile | null {
    return this.file;
  }

  /* The proof for a challenge only the recovery file opens, under the link's name it was saved with; nothing for
     anything else. A challenge sent again is answered the same and gets no more time than its first answer gave. */
  async challenge(body: Uint8Array): Promise<string | null> {
    const file = this.file;
    if (!file) return null;
    const nonce = await answerChallenge(body, file.identity, file.link?.name ?? '');
    if (!nonce) return null;
    const at = this.now().getTime();
    const first = this.answered.get(nonce);
    if (first !== undefined) return at - first < NONCE_MS ? answerProof(nonce) : null;
    if (this.answered.size >= NONCES_KEPT) this.answered.delete(this.answered.keys().next().value!);
    this.answered.set(nonce, at);
    return answerProof(nonce);
  }

  /* Whether this proof was made for this very bundle from a challenge answered within the hour. */
  takes(id: string, proof: string): boolean {
    const at = this.now().getTime();
    for (const [nonce, first] of this.answered) {
      if (at - first < NONCE_MS && sameText(uploadProof(nonce, id), proof)) return true;
    }
    return false;
  }

  incoming(): BundleStore {
    this.store ??= new BundleStore(join(this.ctx.config.controlDir, ...INCOMING));
    return this.store;
  }

  view(file: RecoveryFile): RecoveryView {
    const bundles = this.incoming().list().map(({ id, manifest }) => ({ id, dumpedAt: manifest.dumpedAt, reason: manifest.reason, size: manifest.size, from: manifest.signer }));
    return { company: file.company, link: file.link?.url ?? null, bundles, restore: this.ctx.restores.status() };
  }

  /* One upload among the few that may run at once; false when they all do. */
  enter(): boolean {
    if (this.uploads >= UPLOADS_AT_ONCE) return false;
    this.uploads += 1;
    return true;
  }

  leave(): void {
    this.uploads -= 1;
  }
}

const RecoveryBody = z.object({ code: z.string().min(1).max(200), file: z.string().min(1).max(MAX_FILE) });
const CodeQuery = z.object({ code: z.string().min(1).max(200).optional() });
const RestoreBody = z.object({ code: z.string().min(1).max(200), id: z.uuid() });
const BundleParams = z.object({ id: z.string().regex(UUID) });

const notRecovering = () => new ApiError(404, 'not_found', 'This Hornhoof is not being restored from a recovery file.', 'not_recovering');
const wrongCode = () => new ApiError(403, 'forbidden', 'This setup code is not right. Open the setup link from the server log.', 'setup_code');

/* The routes of a restore after a total loss. None has a session, since there is no company to sign in to: the setup
   code guards what a person does, and the proof of a challenge what a surviving machine sends. Once a company exists
   they all answer that there is nothing to recover. */
export function totalLossRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const loss = ctx.totalLoss;
  const challenges = limiter({ max: 30, windowMs: 60_000 });

  /* No company yet: else everything of the recovery ends here. */
  async function noCompany(): Promise<void> {
    if (await setupNeeded(db)) return;
    loss.end();
    throw notRecovering();
  }
  /* The file that was given, while there is no company. */
  async function recovering(): Promise<RecoveryFile> {
    await noCompany();
    const file = loss.active();
    if (!file) throw notRecovering();
    return file;
  }
  const withCode = (code: string | undefined): void => {
    if (!code || !isSetupCode(config.secret, code)) throw wrongCode();
  };
  /* Whether a bundle comes with the proof of a challenge this server answered for that very bundle, or with the setup
     code. */
  const proven = (req: FastifyRequest, id: string): boolean => {
    const proof = String(req.headers[RECOVERY_PROOF] ?? '');
    const code = CodeQuery.parse(req.query).code;
    return Boolean((proof && loss.takes(id, proof)) || (code && isSetupCode(config.secret, code)));
  };

  /* Whoever set this server up gives it the recovery file. Its text is never logged. */
  app.post('/api/recovery', { bodyLimit: MAX_FILE + 1024, logLevel: 'silent' }, async req => {
    await noCompany();
    const body = RecoveryBody.parse(req.body);
    withCode(body.code);
    const file = await parseRecoveryFile(body.file);
    loss.begin(file);
    return loss.view(file);
  });

  app.get('/api/recovery', async req => {
    const file = await recovering();
    withCode(CodeQuery.parse(req.query).code);
    return loss.view(file);
  });

  app.post('/api/recovery/restore', async (req, reply) => {
    const file = await recovering();
    const body = RestoreBody.parse(req.body);
    withCode(body.code);
    const held = loss.incoming().list().find(bundle => bundle.id === body.id);
    if (!held) throw new ApiError(404, 'not_found', 'There is no such backup here.');
    return reply.code(202).send({ attempt: ctx.restores.startIncoming(file, held.manifest) });
  });

  /* A machine that survived asks whether this server holds the recovery file. */
  void app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CHALLENGE }, (_req, body, done) => done(null, body));
    scope.post('/api/recovery/challenge', { bodyLimit: MAX_CHALLENGE }, async (req, reply) => {
      await recovering();
      guard(reply, challenges, await clientAddress(req, config));
      const proof = Buffer.isBuffer(req.body) ? await loss.challenge(req.body) : null;
      if (!proof) throw new ApiError(400, 'validation', 'This server does not answer this challenge.', 'challenge_refused');
      return { proof };
    });
  });

  /* A bundle comes in, from a surviving machine with the proof of its challenge, or from a browser with the setup
     code. Who has neither is refused before anything of the body is read, and what is no bundle of this recovery key
     is cut as soon as its head says so. */
  void app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.put('/api/recovery/bundles/:id', async (req, reply) => {
      const refuse = (err: ApiError): never => {
        /* Nothing more of the body is read, so the connection ends with the answer. */
        reply.header('connection', 'close');
        throw err;
      };
      const file = await recovering().catch(refuse);
      const { id } = BundleParams.parse(req.params);
      if (!proven(req, id)) refuse(new ApiError(403, 'forbidden', 'This bundle comes with no proof this server takes.'));
      if (loss.incoming().has(id)) refuse(new ApiError(409, 'conflict', 'This server has this backup already.', 'have_it'));
      if (!loss.enter()) refuse(new ApiError(429, 'too_many', 'Too many backups are coming in at once. Try again in a moment.'));
      try {
        await take(req, file, id);
      } catch (err) {
        if (!(err instanceof BundleRefused)) throw err;
        refuse(new ApiError(400, 'validation', err.message, 'bundle_refused', { why: err.reason }));
      } finally {
        loss.leave();
      }
      return reply.code(201).send({ id });
    });
  });

  /* What takes the bundle reads a copy of the request and may cut that at any moment, while the request itself stays
     for the answer. */
  async function take(req: FastifyRequest, file: RecoveryFile, id: string): Promise<void> {
    const body = new PassThrough();
    body.on('error', () => undefined);
    req.raw.pipe(body);
    req.raw.once('close', () => body.destroy());
    try {
      await loss.incoming().take(
        body,
        head => {
          const manifest = checkHead(head, { authorityPem: file.authorityPem, company: file.company });
          if (manifest.recovery !== file.recipient) throw new BundleRefused('key', 'This backup was not made for this recovery file.');
          return manifest;
        },
        { id },
      );
    } finally {
      req.raw.unpipe(body);
      body.destroy();
    }
  }
}
