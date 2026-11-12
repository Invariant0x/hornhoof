import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gzipSync } from 'node:zlib';
import * as age from 'age-encryption';
import { describe, expect, it, onTestFinished } from 'vitest';
import { checkHead, headLine } from '../src/modules/backups/bundle.js';
import { BundleStore } from '../src/modules/backups/store.js';
import type { MakerView } from '../src/modules/backups/types.js';
import { BUNDLES_DIR } from '../src/modules/keeper/backups.js';
import { LED_FILE, LED_RETRY_MS, LedSaver, readLed } from '../src/modules/keeper/led.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { createTestSql, ownDatabases } from './helpers.js';

/* These tests write the term a database stands under, which a truncate does not undo. */
ownDatabases();

const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000c';
const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-led-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The keeper of A, a machine that led under term 7 and follows B now, with its updater and the keeper of B played by the test. */
async function saver() {
  const [dir, controlDir] = [folder(), folder()];
  const { sql } = await createTestSql();
  await sql.query('SET session_replication_role = replica');
  await sql.query('DELETE FROM net_local.lease; DELETE FROM net_local.state');
  await sql.query(`INSERT INTO net_local.state (term_number, term_machine, term_split, machine, cluster) VALUES (7, $1, false, $1, 'c')`, [A]);
  const authority = await makeAuthority(COMPANY);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
  const machineId = randomUUID();
  const issued = await issueCertificate(authority, { machineId, role: 'data', signKey: key.publicPem, now: new Date(Date.now() - 86_400_000) });
  const identity = await age.generateX25519Identity();
  const [own, others] = [await age.identityToRecipient(identity), await age.identityToRecipient(await age.generateX25519Identity())];
  const said = { now: new Date(), view: { company: COMPANY, recipients: [others], recovery: null, last: null, holders: {}, wanted: [], order: null, fork: null } as MakerView | null, put: 201 as number | null };
  const puts: { to: string; id: string; bytes: number }[] = [];
  const lines: string[] = [];
  const make = () =>
    new LedSaver({
      dir, controlDir, sql, key, age: async () => ({ recipient: own }),
      held: () => ({ machine: machineId, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() }),
      secrets: () => ({ HORNHOOF_SECRET: 's'.repeat(44), NODE_KEY: 'n'.repeat(44), RELAY_URL: 'https://relay.hornhoof.test' }),
      leader: () => ({ networkId: B }),
      view: async () => said.view,
      put: async (to, id, bundle) => {
        puts.push({ to, id, bytes: (await buffer(bundle.stream())).length });
        return said.put;
      },
      now: () => said.now, log: line => lines.push(line),
    });
  const request = () => (existsSync(join(controlDir, 'dump.json')) ? (JSON.parse(readFileSync(join(controlDir, 'dump.json'), 'utf8')) as { id: string; database: string; reason: string }) : null);
  /* The updater's part: the dump of the database the request names, or a line why not. */
  const updater = (failed?: string) => {
    const { id } = request()!;
    mkdirSync(join(controlDir, 'dumps'), { recursive: true });
    if (failed) writeFileSync(join(controlDir, 'dumps', `${id}.failed`), `${failed}\n`);
    else {
      writeFileSync(join(controlDir, 'dumps', `${id}.sql.gz`), gzipSync('-- everything this machine did while it led'));
      writeFileSync(join(controlDir, 'dumps', `${id}.json`), JSON.stringify({ id, reason: 'fork', at: said.now.toISOString(), migrations: 116 }));
    }
    rmSync(join(controlDir, 'dump.json'));
  };
  const store = () => new BundleStore(join(dir, BUNDLES_DIR));
  const check = (head: string) => checkHead(head, { authorityPem: authority.certPem, company: COMPANY });
  return { dir, controlDir, sql, make, it: make(), said, puts, lines, request, updater, store, check, machineId };
}

describe('saving the database of a machine that led', () => {
  it('saves what it led before anything else', async () => {
    const s = await saver();
    expect([s.it.state(), s.it.done()]).toEqual([null, false]);
    await s.it.tick();
    /* Its dump is asked of the updater, under a new id, with the term it led under written down. */
    const led = readLed(s.dir)!;
    expect(led).toMatchObject({ term: 7, sealed: false, recorded: false, failed: null });
    expect(s.request()).toEqual({ id: led.id, database: 'hornhoof', reason: 'fork' });
    /* Asked once: the looks that follow wait for it. */
    await s.it.tick();
    expect([s.puts, readLed(s.dir)!.id]).toEqual([[], led.id]);
    s.updater();
    await s.it.tick();
    /* One sealed bundle, a fork, signed by this machine, which the keeper that leads took: the dump goes. */
    const [bundle] = s.store().list();
    expect(s.check(bundle!.head)).toMatchObject({ id: led.id, reason: 'fork', signer: s.machineId, migrations: 116 });
    /* It travels as any bundle does: its head, then its sealed part. */
    expect(s.puts).toEqual([{ to: B, id: led.id, bytes: Buffer.byteLength(headLine(bundle!.head)) + bundle!.size }]);
    expect([s.it.done(), readLed(s.dir)]).toMatchObject([true, { sealed: true, recorded: true }]);
    expect(['sql.gz', 'json'].map(end => existsSync(join(s.controlDir, 'dumps', `${led.id}.${end}`)))).toEqual([false, false]);
    /* Done, it asks nobody again. */
    await s.it.tick();
    expect(s.puts).toHaveLength(1);
    expect(s.lines).toEqual(['This machine led the company before: what it did then is saved before its copy is made again.', 'What this machine did while it led is saved with the company server.']);
  });

  it('saves nothing of a database that never led, or that handed the server over', async () => {
    const s = await saver();
    await s.sql.query(`UPDATE net_local.state SET handed_to = $1, handed_lsn = '0/3000000', handed_at = now()`, [B]);
    await s.it.tick();
    expect([s.it.state(), s.request(), existsSync(join(s.dir, LED_FILE))]).toEqual([null, null, false]);
  });

  it('goes on after a restart in each step', async () => {
    const s = await saver();
    await s.it.tick();
    const { id } = readLed(s.dir)!;
    /* Started again while the updater dumps: no second request, the same id. */
    const waiting = s.make();
    await waiting.tick();
    expect([readLed(s.dir)!.id, s.request()?.id]).toEqual([id, id]);
    s.updater();
    /* Sealed, and the keeper that leads did not answer: a keeper that starts again seals nothing anew and gives it again. */
    s.said.put = null;
    await waiting.tick();
    expect([readLed(s.dir), s.puts.length, s.store().list().length]).toMatchObject([{ sealed: true, recorded: false }, 1, 1]);
    const sealed = s.make();
    s.said.put = 201;
    await sealed.tick();
    expect([sealed.done(), s.puts.length, s.store().list().length, s.request()]).toEqual([true, 2, 1, null]);
  });

  it('tries the leader again', async () => {
    const s = await saver();
    await s.it.tick();
    s.updater();
    for (const answer of [null, 503, 200]) {
      s.said.put = answer;
      await s.it.tick();
    }
    expect([s.puts.length, s.store().list().length, s.it.done()]).toEqual([3, 1, true]);
    /* With no view of whom the company's backups are sealed to, nothing is sealed yet. */
    const blind = await saver();
    blind.said.view = null;
    await blind.it.tick();
    blind.updater();
    await blind.it.tick();
    expect([blind.store().list(), blind.puts]).toEqual([[], []]);
  });

  it('says when the updater could not dump, and asks again ten minutes later', async () => {
    const s = await saver();
    await s.it.tick();
    const { id } = readLed(s.dir)!;
    s.updater('No space left on device');
    await s.it.tick();
    expect(readLed(s.dir)).toMatchObject({ id, failed: 'No space left on device', sealed: false });
    expect(s.lines.at(-1)).toBe('The updater could not dump the database this machine led with: No space left on device');
    /* No new request before ten minutes passed. */
    s.said.now = new Date(s.said.now.getTime() + LED_RETRY_MS - 1000);
    await s.it.tick();
    expect(s.request()).toBeNull();
    s.said.now = new Date(s.said.now.getTime() + 1000);
    await s.it.tick();
    expect(s.request()).toEqual({ id, database: 'hornhoof', reason: 'fork' });
    s.updater();
    await s.it.tick();
    expect([s.it.done(), readLed(s.dir)?.failed]).toEqual([true, null]);
  });
});
