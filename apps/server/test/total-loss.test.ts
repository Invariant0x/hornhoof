import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as age from 'age-encryption';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { answerProof, makeChallenge, uploadProof, type Manifest } from '../src/modules/backups/bundle.js';
import type { RecoveryFile } from '../src/modules/backups/recovery.js';
import { knownMigrations } from '../src/modules/backups/restore.js';
import { BundleStore } from '../src/modules/backups/store.js';
import { NONCE_MS, RECOVERY_LINK, UPLOADS_AT_ONCE, type RecoveryView } from '../src/modules/backups/total-loss.js';
import type { MakerView } from '../src/modules/backups/types.js';
import { saveLink } from '../src/modules/link/link.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { authorityOf } from '../src/modules/network/store.js';
import { setupCode } from '../src/modules/setup/code.js';
import { SETUP, testApp } from './helpers.js';
import { backupCompany, machineKey, OWN } from './helpers-backups.js';

const LINK = { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test' } };
const MINUTE = 60_000;
type Refusal = { error: { reason?: string; details?: { why?: string } } };
const reasonOf = (answer: { json(): unknown }) => (answer.json() as Refusal).error.reason;
const storeBundle = (store: BundleStore, b: { id: string; head: string; manifest: Manifest; out: string }) =>
  store.seal(b.id, part => {
    copyFileSync(b.out, part);
    return Promise.resolve({ head: b.head, manifest: b.manifest });
  });

/* The company that was lost, with its recovery file and bundles made for it; and a server set up anew, which has no
   company yet. */
async function stand(over: { link?: boolean } = {}) {
  const lost = await backupCompany();
  if (over.link !== false) await saveLink(lost.db, lost.config, lost.acme.id, LINK);
  const text = ((await lost.recoveryFile()).json() as { text: string }).text;
  const file = JSON.parse(text.split('\n')[1]!) as RecoveryFile;
  const bundle = (more: Parameters<typeof lost.head>[0] = {}) => lost.head({ recovery: file.recipient, recoveryLink: file.link ? { name: file.link.name, url: file.link.url } : null, ...more });
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  writeFileSync(join(control, 'alive'), '');
  const fresh = await testApp({ HORNHOOF_CONTROL_DIR: control, TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: 'f'.repeat(64) });
  const code = setupCode(fresh.config.secret);
  const { app } = fresh;
  const begin = (given = text, with_ = code) => app.inject({ method: 'POST', url: '/api/recovery', payload: { code: with_, file: given } });
  const challenge = (body: Uint8Array | Buffer, from = '127.0.0.1') => app.inject({ method: 'POST', url: '/api/recovery/challenge', payload: Buffer.from(body), headers: { 'content-type': 'application/octet-stream' }, remoteAddress: from });
  /* A challenge as a surviving machine makes it, answered: the number it carried. */
  const answered = async (): Promise<string> => {
    const made = await makeChallenge(file.recipient, file.link?.name ?? '');
    expect((await challenge(made.file)).statusCode).toBe(200);
    return made.nonce;
  };
  const put = (id: string, body: Buffer, how: { proof?: string; code?: string } = {}) =>
    app.inject({ method: 'PUT', url: `/api/recovery/bundles/${id}${how.code ? `?code=${how.code}` : ''}`, payload: body, headers: { 'content-type': 'application/octet-stream', ...(how.proof ? { 'x-hornhoof-recovery': how.proof } : {}) } });
  const view = async () => (await app.inject({ url: `/api/recovery?code=${code}` })).json() as RecoveryView;
  return { lost, text, file, bundle, control, fresh, app, code, begin, challenge, answered, put, view };
}

/* The clock a moment later, for what counts an hour. */
async function later<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await work();
  } finally {
    Date.now = real;
  }
}

describe('a restore after the server was lost', () => {
  it('begins with the setup code alone', async () => {
    const s = await stand();
    expect((await s.app.inject({ url: '/api/setup' })).json()).toMatchObject({ needed: true, recovering: false });
    /* Before a file was given there is nothing to ask. */
    expect([(await s.app.inject({ url: `/api/recovery?code=${s.code}` })).statusCode, reasonOf(await s.challenge(Buffer.alloc(8)))]).toEqual([404, 'not_recovering']);
    const wrong = await s.begin(s.text, 'not-the-code');
    expect([wrong.statusCode, reasonOf(wrong)]).toEqual([403, 'setup_code']);
    expect(existsSync(join(s.control, RECOVERY_LINK))).toBe(false);
    expect((await s.begin('not a file')).statusCode).toBe(400);
    const begun = await s.begin();
    expect(begun.statusCode).toBe(200);
    expect(begun.json()).toEqual({ company: s.lost.acme.id, link: LINK.url, bundles: [], restore: null });
    expect((await s.app.inject({ url: '/api/setup' })).json()).toMatchObject({ needed: true, recovering: true });
    /* The link of the file, for the keeper's link child and for it alone; nothing of the file's private half. */
    const link = join(s.control, RECOVERY_LINK);
    expect([JSON.parse(readFileSync(link, 'utf8')), statSync(link).mode & 0o777]).toEqual([LINK, 0o600]);
    expect((await s.app.inject({ url: '/api/recovery?code=wrong' })).statusCode).toBe(403);
    expect((await s.app.inject({ url: '/api/recovery' })).statusCode).toBe(403);
    /* A file with no link leaves no link there. */
    const plain = await stand({ link: false });
    expect((await plain.begin()).json()).toMatchObject({ link: null });
    expect(existsSync(join(plain.control, RECOVERY_LINK))).toBe(false);
  });

  it('answers only its own challenge', async () => {
    const s = await stand();
    await s.begin();
    const made = await makeChallenge(s.file.recipient, LINK.name);
    const answer = await s.challenge(made.file);
    expect([answer.statusCode, answer.json()]).toEqual([200, { proof: answerProof(made.nonce) }]);
    expect(answer.body).not.toContain(made.nonce);
    /* Under another link's name, to another key, a bundle, and garbage. */
    const stranger = await age.identityToRecipient(await age.generateX25519Identity());
    const sealed = await s.bundle();
    const refused = [(await makeChallenge(s.file.recipient, 'other')).file, (await makeChallenge(stranger, LINK.name)).file, readFileSync(sealed.out).subarray(0, 900), Buffer.from('garbage')];
    for (const body of refused) {
      const said = await s.challenge(body, '192.0.2.1');
      expect([said.statusCode, reasonOf(said)]).toEqual([400, 'challenge_refused']);
    }
    expect((await s.challenge(Buffer.alloc(1025), '192.0.2.2')).statusCode).toBe(413);
    /* Thirty a minute from one address, and the next is turned away. */
    const statuses: number[] = [];
    for (let asked = 0; asked < 31; asked += 1) statuses.push((await s.challenge(Buffer.from('x'), '192.0.2.3')).statusCode);
    expect([statuses.slice(0, 30).every(status => status === 400), statuses[30]]).toEqual([true, 429]);
  });

  it('takes only bundles of its recovery key', async () => {
    const s = await stand();
    await s.begin();
    const nonce = await s.answered();
    const good = await s.bundle();
    /* Without a proof, with the proof of another bundle, with one made from another number. */
    const other = randomUUID();
    for (const how of [{}, { proof: uploadProof(nonce, other) }, { proof: uploadProof('A'.repeat(43), good.id) }, { proof: `${'A'.repeat(42)}\u00e9` }, { code: 'wrong' }]) expect((await s.put(good.id, good.travels(), how)).statusCode).toBe(403);
    const taken = await s.put(good.id, good.travels(), { proof: uploadProof(nonce, good.id) });
    expect([taken.statusCode, taken.json()]).toEqual([201, { id: good.id }]);
    expect((await s.view()).bundles).toEqual([{ id: good.id, dumpedAt: good.manifest.dumpedAt, reason: 'timer', size: good.manifest.size, from: good.manifest.signer }]);
    const again = await s.put(good.id, good.travels(), { proof: uploadProof(nonce, good.id) });
    expect([again.statusCode, reasonOf(again)]).toEqual([409, 'have_it']);

    /* Of another recovery key, signed by a machine that holds no data, of another company's authority, under another
       bundle's id, and longer than its head says. */
    const stranger = await age.identityToRecipient(await age.generateX25519Identity());
    const authority = (await authorityOf(s.lost.db, s.lost.config))!;
    const workerKey = machineKey();
    const workerId = randomUUID();
    const asWorker = await issueCertificate(authority, { machineId: workerId, role: 'worker', signKey: workerKey.publicPem });
    const strangers = await makeAuthority(randomUUID());
    const elsewhereKey = machineKey();
    const elsewhereId = randomUUID();
    const elsewhere = await issueCertificate(strangers, { machineId: elsewhereId, role: 'data', signKey: elsewhereKey.publicPem });
    const bad: [string, Awaited<ReturnType<typeof s.bundle>>, Buffer?][] = [
      ['key', await s.bundle({ recovery: stranger })],
      ['role', await s.bundle({ key: workerKey, held: { machine: workerId, role: 'worker', certPem: asWorker.certPem, authorityPem: authority.certPem, until: asWorker.until.toISOString() } })],
      ['authority', await s.bundle({ key: elsewhereKey, held: { machine: elsewhereId, role: 'data', certPem: elsewhere.certPem, authorityPem: strangers.certPem, until: elsewhere.until.toISOString() } })],
    ];
    const long = await s.bundle();
    bad.push(['size', long, Buffer.concat([long.travels(), Buffer.alloc(64 * 1024)])]);
    for (const [why, bundle, body] of bad) {
      const refused = await s.put(bundle.id, body ?? bundle.travels(), { proof: uploadProof(nonce, bundle.id) });
      expect([why, refused.statusCode, reasonOf(refused), (refused.json() as Refusal).error.details?.why]).toEqual([why, 400, 'bundle_refused', why]);
    }
    const misnamed = await s.put(other, good.travels(), { proof: uploadProof(nonce, other) });
    expect([misnamed.statusCode, reasonOf(misnamed)]).toEqual([400, 'bundle_refused']);
    expect((await s.view()).bundles.map(bundle => bundle.id)).toEqual([good.id]);
    expect(readdirSync(join(s.control, 'restore', 'incoming')).filter(name => name.endsWith('.part'))).toEqual([]);

    /* Two at once at most. */
    const second = await s.bundle();
    for (let running = 0; running < UPLOADS_AT_ONCE; running += 1) expect(s.app.ctx.totalLoss.enter()).toBe(true);
    expect((await s.put(second.id, second.travels(), { proof: uploadProof(nonce, second.id) })).statusCode).toBe(429);
    for (let running = 0; running < UPLOADS_AT_ONCE; running += 1) s.app.ctx.totalLoss.leave();
    /* From a browser, with the setup code. */
    expect((await s.put(second.id, second.travels(), { code: s.code })).statusCode).toBe(201);
    expect((await s.view()).bundles).toHaveLength(2);
  });

  it('gives whoever carries its traffic nothing to reuse', async () => {
    const s = await stand();
    await s.begin();
    /* What a relay sees: the challenge, its answer, and one upload with its header. */
    const made = await makeChallenge(s.file.recipient, LINK.name);
    const proof = ((await s.challenge(made.file)).json() as { proof: string }).proof;
    const [first, second] = [await s.bundle(), await s.bundle()];
    const seen = uploadProof(made.nonce, first.id);
    expect((await s.put(first.id, first.travels(), { proof: seen })).statusCode).toBe(201);
    /* The header of that upload, and the answer to the challenge, open the way for no other bundle. */
    for (const replayed of [seen, proof]) expect((await s.put(second.id, second.travels(), { proof: replayed })).statusCode).toBe(403);
    /* The challenge sent again gets the same answer, and no more time than its first answer gave. */
    await later(59 * MINUTE, async () => {
      expect(((await s.challenge(made.file)).json() as { proof: string }).proof).toBe(proof);
      expect((await s.put(second.id, second.travels(), { proof: uploadProof(made.nonce, second.id) })).statusCode).toBe(201);
    });
    await later(NONCE_MS + MINUTE, async () => {
      const third = await s.bundle();
      expect((await s.put(third.id, third.travels(), { proof: uploadProof(made.nonce, third.id) })).statusCode).toBe(403);
      expect((await s.challenge(made.file, '192.0.2.9')).statusCode).toBe(400);
      expect((await s.put(third.id, third.travels(), { proof: uploadProof(made.nonce, third.id) })).statusCode).toBe(403);
    });
  });

  it('restores through the keeper, with no database to check against and none to carry from', async () => {
    const s = await stand();
    await s.begin();
    const nonce = await s.answered();
    const good = await s.bundle();
    await s.put(good.id, good.travels(), { proof: uploadProof(nonce, good.id) });
    const restore = (payload: object) => s.app.inject({ method: 'POST', url: '/api/recovery/restore', payload });
    expect((await restore({ code: 'wrong', id: good.id })).statusCode).toBe(403);
    expect((await restore({ code: s.code, id: randomUUID() })).statusCode).toBe(404);
    const asked = await restore({ code: s.code, id: good.id });
    expect(asked.statusCode).toBe(202);
    const view = (await s.app.inject({ url: '/api/network/backups', ...OWN })).json() as MakerView;
    expect(view).toMatchObject({ company: null, wanted: [] });
    expect(view.order).toEqual({
      attempt: (asked.json() as { attempt: string }).attempt, id: good.id, dumpedAt: good.manifest.dumpedAt, source: 'incoming', identity: s.file.identity, expect: null,
      company: s.lost.acme.id, authorityPem: s.file.authorityPem, carry: false,
    });
    expect(reasonOf(await restore({ code: s.code, id: good.id }))).toBe('restore_busy');
    /* A bundle of a newer build is not for this one. */
    const newer = await stand();
    await newer.begin();
    const ahead = await newer.bundle({ migrations: knownMigrations() + 1 });
    await newer.put(ahead.id, ahead.travels(), { code: newer.code });
    expect(reasonOf(await newer.app.inject({ method: 'POST', url: '/api/recovery/restore', payload: { code: newer.code, id: ahead.id } }))).toBe('newer_build');
  });

  it('keeps the recovery file in memory only, and lets go of what another file brought', async () => {
    const s = await stand();
    await s.begin();
    const good = await s.bundle();
    await s.put(good.id, good.travels(), { code: s.code });
    const written: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else written.push(readFileSync(path, 'latin1'));
      }
    };
    walk(s.control);
    const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;
    const tables = rowsOf<{ name: string }>(await s.fresh.db.execute(sql`SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('public', 'net', 'net_local')`));
    for (const { name } of tables) written.push(JSON.stringify(rowsOf(await s.fresh.db.execute(sql.raw(`SELECT row_to_json(t)::text AS row FROM ${name} t`)))));
    const stretches = Array.from({ length: s.file.identity.length - 20 }, (_, at) => s.file.identity.slice(at, at + 20));
    expect(written.length).toBeGreaterThan(tables.length);
    expect(written.filter(text => stretches.some(stretch => text.includes(stretch)))).toEqual([]);
    /* Another company's file takes the place of the first, and the first one's bundles go. */
    const other = await stand();
    expect((await s.begin(other.text)).json()).toMatchObject({ company: other.lost.acme.id, bundles: [] });
    expect((await s.put(good.id, good.travels(), { code: s.code })).statusCode).toBe(400);
  });

  it('keeps of what came in before only what the file it is given opens', async () => {
    /* The app restarted and lost the file; bundles of two companies lie there from before. */
    const s = await stand();
    const other = await stand();
    const store = new BundleStore(join(s.control, 'restore', 'incoming'));
    const [mine, theirs] = [await s.bundle(), await other.bundle()];
    for (const bundle of [mine, theirs]) await storeBundle(store, bundle);
    expect(store.list()).toHaveLength(2);
    expect((await s.begin()).json()).toMatchObject({ bundles: [{ id: mine.id }] });
    expect(store.list().map(bundle => bundle.id)).toEqual([mine.id]);
  });

  it('empties what was sent for a recovery once the company is back', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
    const s = await stand();
    const left = await s.bundle();
    /* A restored server starts: the bundles the survivors sent still lie in its control folder. */
    const lying = new BundleStore(join(control, 'restore', 'incoming'));
    await storeBundle(lying, left);
    writeFileSync(join(control, RECOVERY_LINK), '{}');
    const restored = await testApp({ HORNHOOF_CONTROL_DIR: control, TUNNEL_HOST: 'localhost' });
    await restored.app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
    await restored.app.ctx.totalLoss.tidy();
    expect([lying.list(), existsSync(join(control, RECOVERY_LINK))]).toEqual([[], false]);
    /* A server with no company yet keeps what it was sent. */
    const waiting = mkdtempSync(join(tmpdir(), 'hh-control-'));
    const kept = await s.bundle();
    await storeBundle(new BundleStore(join(waiting, 'restore', 'incoming')), kept);
    const fresh = await testApp({ HORNHOOF_CONTROL_DIR: waiting, TUNNEL_HOST: 'localhost' });
    await fresh.app.ctx.totalLoss.tidy();
    expect(new BundleStore(join(waiting, 'restore', 'incoming')).list()).toHaveLength(1);
  });

  it('closes once a company exists', async () => {
    const s = await stand();
    await s.begin();
    const nonce = await s.answered();
    const sent = await s.bundle();
    expect((await s.put(sent.id, sent.travels(), { code: s.code })).statusCode).toBe(201);
    expect((await s.app.inject({ method: 'POST', url: `/api/setup?code=${s.code}`, payload: { ...SETUP, code: s.code } })).statusCode).toBe(201);
    expect(existsSync(join(s.control, RECOVERY_LINK))).toBe(false);
    const good = await s.bundle();
    const asked = [
      await s.begin(),
      await s.app.inject({ url: `/api/recovery?code=${s.code}` }),
      await s.challenge((await makeChallenge(s.file.recipient, LINK.name)).file),
      await s.put(good.id, good.travels(), { proof: uploadProof(nonce, good.id) }),
      await s.app.inject({ method: 'POST', url: '/api/recovery/restore', payload: { code: s.code, id: good.id } }),
    ];
    expect(asked.map(answer => [answer.statusCode, reasonOf(answer)])).toEqual(asked.map(() => [404, 'not_recovering']));
    /* What was sent for the recovery goes with it. */
    expect(readdirSync(join(s.control, 'restore', 'incoming'))).toEqual([]);
    expect((await s.app.inject({ url: '/api/setup' })).json()).toMatchObject({ needed: false, recovering: false });
  });
});
