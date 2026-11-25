import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as age from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { sealBundle, type BundleSecrets } from '../src/modules/backups/bundle.js';
import { BundleStore } from '../src/modules/backups/store.js';
import type { RestoreOrder, RestoreStatus } from '../src/modules/backups/types.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { FETCH_WAIT_MS, RestoreRunner } from '../src/modules/keeper/restore.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { until } from './helpers-basic.js';

const COMPANY = randomUUID();
const SECRETS: BundleSecrets = { HORNHOOF_SECRET: `${'A'.repeat(43)}=`, NODE_KEY: 'k'.repeat(40), RELAY_URL: 'https://relay.hornhoof.test' };
const DUMPED = '2026-11-10T08:00:00.000Z';
const GIB = 1024 ** 3;
const CALLED_OFF = 'The restore was called off.';
const NO_MATCH = 'This backup does not match what the company recorded.';
const NEEDS_FILE = 'This server cannot open the backup. Add the recovery file it was made for.';

function machineKey(): MachineKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

async function ageKey() {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/* The keeper of the machine that holds the data, with its stores, its control folder and the bundles it made. */
async function stand(over: { fetchWaitMs?: number } = {}) {
  const authority = await makeAuthority(COMPANY);
  const key = machineKey();
  const machine = randomUUID();
  const issued = await issueCertificate(authority, { machineId: machine, role: 'data', signKey: key.publicPem });
  const held: HeldCertificate = { machine, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
  const [own, recovery] = [await ageKey(), await ageKey()];
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const stores = { own: new BundleStore(mkdtempSync(join(tmpdir(), 'hh-own-'))), incoming: new BundleStore(join(controlDir, 'restore', 'incoming')) };
  const elsewhere = mkdtempSync(join(tmpdir(), 'hh-sealed-'));
  const dump = randomBytes(96 * 1024);
  /* A bundle of the company, sealed to this machine's key unless the test says to whom. */
  const seal = async (recipients: string[] = [own.recipient], recoveryKey: string | null = null) => {
    const id = randomUUID();
    const out = join(elsewhere, `${id}.age`);
    const made = await sealBundle({
      dump: Readable.from([dump]), id, company: COMPANY, dumpedAt: new Date(DUMPED), reason: 'timer', migrations: 106, secrets: SECRETS,
      recipients, recovery: recoveryKey, recoveryLink: null, key, held, out,
    });
    return { id, out, ...made };
  };
  type Sealed = Awaited<ReturnType<typeof seal>>;
  const keep = (bundle: Sealed, inStore = stores.own) =>
    inStore.seal(bundle.id, part => {
      copyFileSync(bundle.out, part);
      return Promise.resolve({ head: bundle.head, manifest: bundle.manifest });
    });
  const orderFor = (bundle: Sealed, more: Partial<RestoreOrder> = {}): RestoreOrder => ({
    attempt: randomUUID(), id: bundle.id, dumpedAt: DUMPED, source: 'store', identity: null,
    expect: { sha256: bundle.manifest.sha256, size: bundle.manifest.size, signer: bundle.manifest.signer }, company: COMPANY, authorityPem: authority.certPem, carry: true, ...more,
  });
  const lines: string[] = [];
  const said = { free: 100 * GIB };
  const steps: string[] = [];
  const runner = () => new RestoreRunner({
    controlDir, ...stores, identity: own.identity, log: line => lines.push(line), diskFree: () => said.free, fetchWaitMs: over.fetchWaitMs, pollMs: 10,
    /* Every status as it is written, in its order. */
    onStatus: status => steps.push(`${status.state} ${status.step}`),
  });
  const status = (): RestoreStatus | null => {
    try {
      return JSON.parse(readFileSync(join(controlDir, 'restore-status.json'), 'utf8')) as RestoreStatus;
    } catch {
      return null;
    }
  };
  const ended = (attempt: string) => until(() => status()?.attempt === attempt && status()?.state !== 'running' || existsSync(join(controlDir, 'restore.json')));
  /* What lies in restore/, but the folder of what holders sent. */
  const left = () => (existsSync(join(controlDir, 'restore')) ? readdirSync(join(controlDir, 'restore')).filter(name => name !== 'incoming').sort() : []);
  const asked = () => JSON.parse(readFileSync(join(controlDir, 'restore.json'), 'utf8')) as Record<string, unknown>;
  return { authority, own, recovery, controlDir, stores, dump, seal, keep, orderFor, runner, lines, said, steps, status, ended, left, asked };
}

describe("the keeper's part of a restore", () => {
  it('opens a bundle into the control folder', async () => {
    const s = await stand();
    const bundle = await s.seal();
    await s.keep(bundle);
    const order = s.orderFor(bundle);
    const runner = s.runner();
    runner.take(order);
    await until(() => existsSync(join(s.controlDir, 'restore.json')));
    expect(s.asked()).toEqual({ attempt: order.attempt, id: bundle.id, dumpedAt: DUMPED, carry: true });
    const [dump, env] = [join(s.controlDir, 'restore', `${order.attempt}.sql.gz`), join(s.controlDir, 'restore', `${order.attempt}.env.json`)];
    expect(readFileSync(dump).equals(s.dump)).toBe(true);
    expect(JSON.parse(readFileSync(env, 'utf8'))).toEqual(SECRETS);
    expect([dump, env].map(path => statSync(path).mode & 0o777)).toEqual([0o600, 0o600]);
    expect(statSync(join(s.controlDir, 'restore')).mode & 0o777).toBe(0o700);
    expect(s.left()).toEqual([`${order.attempt}.env.json`, `${order.attempt}.sql.gz`]);
    /* The updater takes over from here: the keeper's last word is that it opens. */
    expect(s.steps).toEqual(['running fetch', 'running check', 'running open']);
    expect(s.status()).toMatchObject({ attempt: order.attempt, id: bundle.id, state: 'running', step: 'open', kept: null });
    /* The same order again, as every view repeats it, starts nothing anew. */
    runner.take(order);
    runner.take(order);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.steps).toHaveLength(3);
    expect(FETCH_WAIT_MS).toBe(1_800_000);
  });

  it('opens with the recovery file it was handed, and only with it', async () => {
    const s = await stand();
    const bundle = await s.seal([], s.recovery.recipient);
    await s.keep(bundle);
    const without = s.orderFor(bundle);
    const runner = s.runner();
    runner.take(without);
    await s.ended(without.attempt);
    expect(s.status()).toMatchObject({ attempt: without.attempt, state: 'failed', step: 'open', line: NEEDS_FILE });
    expect([s.left(), existsSync(join(s.controlDir, 'restore.json'))]).toEqual([[], false]);
    const withFile = s.orderFor(bundle, { identity: s.recovery.identity, carry: false });
    runner.take(withFile);
    await until(() => existsSync(join(s.controlDir, 'restore.json')));
    expect(s.asked()).toEqual({ attempt: withFile.attempt, id: bundle.id, dumpedAt: DUMPED, carry: false });
    expect(readFileSync(join(s.controlDir, 'restore', `${withFile.attempt}.sql.gz`)).equals(s.dump)).toBe(true);
  });

  it('keeps the recovery identity in memory only', async () => {
    const s = await stand();
    const bundle = await s.seal([], s.recovery.recipient);
    await s.keep(bundle);
    const runner = s.runner();
    /* Once with a key that opens nothing, once with the right one. */
    const wrong = (await ageKey()).identity;
    const first = s.orderFor(bundle, { identity: wrong });
    runner.take(first);
    await s.ended(first.attempt);
    const second = s.orderFor(bundle, { identity: s.recovery.identity });
    runner.take(second);
    await until(() => existsSync(join(s.controlDir, 'restore.json')));
    const written: string[] = [...s.lines];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else written.push(readFileSync(path, 'latin1'));
      }
    };
    walk(s.controlDir);
    for (const identity of [wrong, s.recovery.identity, s.own.identity]) {
      const stretches = Array.from({ length: identity.length - 20 }, (_, at) => identity.slice(at, at + 20));
      expect(written.filter(text => stretches.some(stretch => text.includes(stretch)))).toEqual([]);
    }
  });

  it('refuses a bundle that does not match the record', async () => {
    const s = await stand();
    const [bundle, other] = [await s.seal(), await s.seal()];
    await s.keep(bundle);
    const runner = s.runner();
    const wrongHash = s.orderFor(bundle, { expect: { sha256: other.manifest.sha256, size: bundle.manifest.size, signer: bundle.manifest.signer } });
    const strangers = await makeAuthority(randomUUID());
    const refused: RestoreOrder[] = [
      wrongHash,
      s.orderFor(bundle, { expect: { sha256: bundle.manifest.sha256, size: bundle.manifest.size, signer: randomUUID() } }),
      s.orderFor(bundle, { company: randomUUID() }),
      s.orderFor(bundle, { authorityPem: strangers.certPem }),
    ];
    for (const order of refused) {
      runner.take(order);
      await s.ended(order.attempt);
      expect(s.status()).toMatchObject({ attempt: order.attempt, state: 'failed', step: 'check', line: NO_MATCH });
    }
    /* One byte of the stored bundle changed since it was recorded. */
    const file = s.stores.own.ageFile(bundle.id);
    const bytes = readFileSync(file);
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 1;
    writeFileSync(file, bytes);
    const changed = s.orderFor(bundle);
    runner.take(changed);
    await s.ended(changed.attempt);
    expect(s.status()).toMatchObject({ attempt: changed.attempt, state: 'failed', step: 'check', line: NO_MATCH });
    expect([s.left(), existsSync(join(s.controlDir, 'restore.json'))]).toEqual([[], false]);
  });

  it('waits for a holder, then gives up', async () => {
    const s = await stand({ fetchWaitMs: 200 });
    const bundle = await s.seal();
    const runner = s.runner();
    const never = s.orderFor(bundle);
    runner.take(never);
    await s.ended(never.attempt);
    expect(s.status()).toMatchObject({ attempt: never.attempt, state: 'failed', step: 'fetch', line: 'No machine sent the backup.' });
    /* A holder sends it within the wait: into the keeper's own store, or into the folder a total loss takes them in. */
    const late = s.orderFor(bundle);
    runner.take(late);
    await until(() => s.status()?.attempt === late.attempt);
    await s.keep(bundle);
    await until(() => existsSync(join(s.controlDir, 'restore.json')));
    expect(s.asked().attempt).toBe(late.attempt);

    const sent = await stand();
    const incoming = await sent.seal();
    await sent.keep(incoming, sent.stores.incoming);
    const fromIncoming = sent.orderFor(incoming, { source: 'incoming', expect: null });
    sent.runner().take(fromIncoming);
    await until(() => existsSync(join(sent.controlDir, 'restore.json')));
    expect(readFileSync(join(sent.controlDir, 'restore', `${fromIncoming.attempt}.sql.gz`)).equals(sent.dump)).toBe(true);
  });

  it('needs room to open', async () => {
    const s = await stand();
    const bundle = await s.seal();
    await s.keep(bundle);
    s.said.free = Math.floor(2.9 * bundle.manifest.size);
    const order = s.orderFor(bundle);
    s.runner().take(order);
    await s.ended(order.attempt);
    expect(s.status()).toMatchObject({ state: 'failed', step: 'open', line: 'Not enough free disk for the restore.' });
    expect([s.left(), existsSync(join(s.controlDir, 'restore.json'))]).toEqual([[], false]);
  });

  it('stops when its order is gone', async () => {
    const s = await stand();
    const bundle = await s.seal();
    const runner = s.runner();
    const order = s.orderFor(bundle);
    runner.take(order);
    await until(() => s.status()?.step === 'fetch');
    /* The app let go of the order: it restarted, or the hour is over. */
    runner.take(null);
    await s.ended(order.attempt);
    expect(s.status()).toMatchObject({ attempt: order.attempt, state: 'failed', step: 'fetch', line: CALLED_OFF });
    expect([s.left(), existsSync(join(s.controlDir, 'restore.json'))]).toEqual([[], false]);
    /* The bundle comes after all, and nothing follows the order the app let go. */
    await s.keep(bundle);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(existsSync(join(s.controlDir, 'restore.json'))).toBe(false);
    /* Another order takes the place of one that still waits. */
    const [first, second] = [s.orderFor(await s.seal()), s.orderFor(bundle)];
    runner.take(first);
    await until(() => s.status()?.attempt === first.attempt);
    runner.take(second);
    await until(() => existsSync(join(s.controlDir, 'restore.json')));
    expect(s.asked().attempt).toBe(second.attempt);
    expect(s.steps).toContain('failed fetch');
  });

  it('leaves nothing open after a restart', async () => {
    const s = await stand();
    const attempt = randomUUID();
    const dir = join(s.controlDir, 'restore');
    mkdirSync(dir, { recursive: true });
    const leave = () => {
      for (const name of [`${attempt}.sql.gz.part`, `${attempt}.sql.gz`, `${attempt}.env.json`]) writeFileSync(join(dir, name), 'left');
      writeFileSync(join(s.controlDir, 'restore-status.json'), JSON.stringify({ attempt, id: randomUUID(), state: 'running', step: 'open', line: '', at: DUMPED, kept: null }));
    };
    leave();
    s.runner();
    expect(s.left()).toEqual([]);
    expect(s.status()).toMatchObject({ attempt, state: 'failed', step: 'open', line: 'The keeper restarted during the restore.' });
    /* What the updater was asked to take stays for it, and so does its word. */
    leave();
    writeFileSync(join(s.controlDir, 'restore.json'), JSON.stringify({ attempt, id: randomUUID(), dumpedAt: DUMPED, carry: true }));
    s.runner();
    expect(s.left()).toEqual([`${attempt}.env.json`, `${attempt}.sql.gz`]);
    expect(s.status()).toMatchObject({ attempt, state: 'running', step: 'open' });
    /* A status of the updater's own steps is the updater's to end. */
    writeFileSync(join(s.controlDir, 'restore-status.json'), JSON.stringify({ attempt: randomUUID(), id: randomUUID(), state: 'running', step: 'swap', line: '', at: DUMPED, kept: null }));
    s.runner();
    expect(s.status()).toMatchObject({ state: 'running', step: 'swap' });
  });
});
