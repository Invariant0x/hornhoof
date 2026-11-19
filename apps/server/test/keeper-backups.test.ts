import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gzipSync } from 'node:zlib';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { openBundle, type BundleSecrets } from '../src/modules/backups/bundle.js';
import { certificates } from '../src/db/schema.js';
import { bundleRow, bundleRows } from '../src/modules/backups/records.js';
import { FORK_KEEP_MS, REPORT_MAX, REPORTED_BUNDLES } from '../src/modules/backups/types.js';
import { BackupKeeper, BUNDLE_EVERY_MS, BUNDLES_DIR, DUMP_GAP_MS, DUMP_LIFE_MS, type Ask } from '../src/modules/keeper/backups.js';
import { bundleSecrets } from '../src/modules/keeper/keeper.js';
import { saveLink } from '../src/modules/link/link.js';
import { issueCertificate } from '../src/modules/network/authority.js';
import { authorityOf } from '../src/modules/network/store.js';
import type { Peer } from '../src/net/peer-server.js';
import { until } from './helpers-basic.js';
import { backupCompany, machineKey, OWN } from './helpers-backups.js';
import { prepareSharedDatabase } from './helpers-db.js';

/* The embedded database opens as the file is collected, so its cold start is no test's time. */
await prepareSharedDatabase();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SECRETS: BundleSecrets = { HORNHOOF_SECRET: `${'A'.repeat(43)}=`, NODE_KEY: 'k'.repeat(40), RELAY_URL: 'https://relay.hornhoof.test' };
const DUMP = gzipSync('-- a dump of the hornhoof database\n');

/* The server's keeper of backups with its app, a clock the test moves, and the test in the place of the updater. */
async function stand(over: { secrets?: () => BundleSecrets } = {}) {
  const c = await backupCompany();
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-'));
  const start = Date.now();
  let now = start;
  const lines: string[] = [];
  /* record: what the app answers to a bundle's record in place of its own answer. down: it answers nothing. holders:
     which machines it says hold which bundles, in place of what it says itself. */
  const said = { record: null as number | null, down: false, leads: true, holders: null as Record<string, string[]> | null, order: null as object | null, last: undefined as object | null | undefined };
  const asked: string[] = [];
  const ask: Ask = async (method, path, body) => {
    asked.push(`${method} ${path}`);
    if (said.down) throw new Error('the app did not answer');
    if (method === 'POST' && said.record) return { status: said.record, body: null };
    const res = await c.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }), ...OWN });
    try {
      const answer = res.json() as Record<string, unknown>;
      return { status: res.statusCode, body: method === 'GET' ? { ...answer, ...(said.holders ? { holders: said.holders } : {}), ...(said.order ? { order: said.order } : {}), ...(said.last !== undefined ? { last: said.last } : {}) } : answer };
    } catch {
      return { status: res.statusCode, body: null };
    }
  };
  const keeper = new BackupKeeper({
    dir, controlDir, key: c.key, held: () => c.held, age: { identity: c.ownIdentity, recipient: c.ownAge }, secrets: over.secrets ?? (() => SECRETS), ask,
    leads: () => said.leads, log: line => lines.push(line), now: () => new Date(now),
  });
  const dumps = join(controlDir, 'dumps');
  const request = join(controlDir, 'dump.json');
  const wanted = (): string | null => (existsSync(request) ? (JSON.parse(readFileSync(request, 'utf8')) as { id: string }).id : null);
  /* A dump as the updater leaves it: the dump first, then the file that says it is whole. */
  const dumped = (id: string, more: object = {}) => {
    mkdirSync(dumps, { recursive: true });
    writeFileSync(join(dumps, `${id}.sql.gz`), DUMP);
    writeFileSync(join(dumps, `${id}.json`), JSON.stringify({ id, reason: 'timer', at: new Date(now).toISOString(), migrations: 106, ...more }));
    /* Written at the time the test's clock says. */
    for (const end of ['.sql.gz', '.json']) utimesSync(join(dumps, `${id}${end}`), new Date(now), new Date(now));
  };
  /* The updater answers the request there is, and removes it unless it was stopped before that. */
  const updater = (opts: { stopped?: boolean } = {}): string | null => {
    const id = wanted();
    if (!id || existsSync(join(dumps, `${id}.json`))) return null;
    dumped(id);
    if (!opts.stopped) rmSync(request);
    return id;
  };
  const waiting = () => (existsSync(dumps) ? readdirSync(dumps).sort() : []);
  /* One bundle from the asking to the record. */
  const bundle = async (): Promise<string> => {
    await keeper.round();
    const id = updater();
    if (!id) throw new Error('no dump was asked for');
    await keeper.round();
    return id;
  };
  const opened = async (id: string) => {
    const held = keeper.store().list().find(one => one.id === id)!;
    const { secrets, dump } = await openBundle(createReadStream(keeper.store().ageFile(id)), held.manifest, [c.ownIdentity]);
    return { manifest: held.manifest, secrets, dump: await buffer(dump) };
  };
  return { ...c, keeper, controlDir, dir, lines, said, asked, dumps, request, wanted, dumped, updater, waiting, bundle, opened, advance: (ms: number) => void (now += ms), now: () => now };
}

describe('the keeper of backups', () => {
  it('makes a bundle at once, then every 6 hours', async () => {
    const s = await stand();
    await s.keeper.round();
    const first = s.wanted();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.updater()).toBe(first);
    await s.keeper.round();
    /* Sealed, signed and recorded, and nothing of the dump is left in the clear. */
    expect(s.keeper.held()).toEqual([first]);
    const rows = await bundleRows(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, company: s.acme.id, reason: 'timer', migrations: 106, signer: s.held.machine, recovery: null, recipients: [s.ownAge] });
    expect([s.waiting(), s.wanted()]).toEqual([[], null]);
    const bundle = await s.opened(first!);
    expect(bundle.secrets).toEqual(SECRETS);
    expect(bundle.dump.equals(DUMP)).toBe(true);
    expect(s.keeper.view()).toMatchObject({ company: s.acme.id });

    s.advance(5 * HOUR);
    await s.keeper.round();
    expect(s.wanted()).toBeNull();
    s.advance(HOUR);
    await s.keeper.round();
    expect(s.wanted()).not.toBeNull();
    expect(s.wanted()).not.toBe(first);
    expect(BUNDLE_EVERY_MS).toBe(6 * HOUR);
  });

  it('asks for one dump at a time', async () => {
    const s = await stand();
    const dumpedIds: string[] = [];
    const requests: (string | null)[] = [];
    for (let round = 0; round < 10; round += 1) {
      await s.keeper.round();
      requests.push(s.wanted());
      /* An updater stopped before it removed the request. */
      const id = s.updater({ stopped: true });
      if (id) dumpedIds.push(id);
      /* The gap between two dumps passes, and with it the six hours, every third round. */
      if (round % 3 === 2) s.advance(BUNDLE_EVERY_MS);
    }
    /* Four requests in ten rounds, each dumped once; the three that had a round after them became one bundle each,
       recorded once. */
    expect(dumpedIds).toHaveLength(4);
    expect(new Set(dumpedIds).size).toBe(4);
    expect((await bundleRows(s.db)).map(row => row.id).sort()).toEqual(dumpedIds.slice(0, 3).sort());
    expect(s.asked.filter(call => call === 'POST /api/network/backups')).toHaveLength(3);
    /* A request stood until its dump was sealed, and none took its place meanwhile. */
    expect(requests.map(id => (id ? dumpedIds.indexOf(id) : null))).toEqual([0, null, null, 1, null, null, 2, null, null, 3]);
  });

  it('makes one soon after a new recovery file', async () => {
    const s = await stand();
    await saveLink(s.db, s.config, s.acme.id, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test' } });
    const worker = await s.worker('mac');
    const first = await s.bundle();
    s.advance(MINUTE);
    const file = JSON.parse(((await s.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    /* The ten minutes are not over, and a dump is asked for all the same. */
    const second = await s.bundle();
    expect(second).not.toBe(first);
    const [row] = await bundleRows(s.db, { limit: 1 });
    expect(row).toMatchObject({ id: second, recovery: file.recipient, recoveryLink: { name: 'acme', url: 'https://acme.hornhoof.test' }, holders: [worker] });
    expect(row!.recipients).toEqual([s.ownAge, file.recipient].sort());
    /* A second file at once waits for the ten minutes, however often it is made anew. */
    const again = JSON.parse(((await s.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    await s.keeper.round();
    expect(s.wanted()).toBeNull();
    s.advance(DUMP_GAP_MS - MINUTE);
    await s.keeper.round();
    expect(s.wanted()).toBeNull();
    s.advance(MINUTE);
    const third = await s.bundle();
    expect((await bundleRows(s.db, { limit: 1 }))[0]).toMatchObject({ id: third, recovery: again.recipient });
  });

  it('leaves no plaintext dump', async () => {
    const s = await stand();
    /* The app does not take the record: the dump waits, sealed once, and goes with the record. */
    await s.keeper.round();
    const id = s.updater()!;
    s.said.record = 503;
    await s.keeper.round();
    expect(s.waiting()).toEqual([`${id}.json`, `${id}.sql.gz`]);
    expect(await bundleRows(s.db)).toEqual([]);
    s.said.record = null;
    await s.keeper.round();
    expect(s.waiting()).toEqual([]);
    expect((await bundleRows(s.db)).map(row => row.id)).toEqual([id]);
    expect(s.keeper.store().list()).toHaveLength(1);

    /* A dump whose bundle the store holds is not sealed again. */
    s.dumped(id);
    const sealedAt = s.keeper.store().list()[0]!.manifest.madeAt;
    await s.keeper.round();
    expect(s.waiting()).toEqual([]);
    expect(s.keeper.store().list().map(one => one.manifest.madeAt)).toEqual([sealedAt]);

    /* A dump nobody sealed within a day goes, whatever the app does and whether this machine leads. */
    for (const how of ['refuses', 'down', 'not leading'] as const) {
      const old = randomUUID();
      s.dumped(old);
      s.said.record = how === 'refuses' ? 503 : null;
      s.said.down = how === 'down';
      s.said.leads = how !== 'not leading';
      await s.keeper.round();
      expect(s.waiting(), how).toEqual([`${old}.json`, `${old}.sql.gz`]);
      s.lines.length = 0;
      s.advance(DUMP_LIFE_MS + MINUTE);
      await s.keeper.round();
      expect(s.waiting(), how).toEqual([]);
      expect(s.lines.filter(line => line.includes('not sealed within a day')), how).toHaveLength(1);
      expect(DUMP_LIFE_MS).toBe(24 * HOUR);
    }
  });

  it('says so of a dump that failed or cannot be read, and keeps none of it', async () => {
    const s = await stand();
    await s.keeper.round();
    const id = s.wanted()!;
    mkdirSync(s.dumps, { recursive: true });
    writeFileSync(join(s.dumps, `${id}.failed`), 'The database could not be dumped.\n');
    /* What says a dump is whole without the dump, or with words that are none of the updater's. */
    const [alone, odd] = [randomUUID(), randomUUID()];
    writeFileSync(join(s.dumps, `${alone}.json`), JSON.stringify({ id: alone, reason: 'timer', at: new Date().toISOString(), migrations: 106 }));
    s.dumped(odd, { reason: 'whim' });
    s.dumped('not-a-uuid');
    await s.keeper.round();
    expect([s.waiting(), s.wanted()]).toEqual([[], null]);
    expect(s.lines.some(line => line.includes('The database could not be dumped.'))).toBe(true);
    expect(s.keeper.held()).toEqual([]);
    /* It does not ask again before the ten minutes are over. */
    await s.keeper.round();
    expect(s.wanted()).toBeNull();
    s.advance(DUMP_GAP_MS);
    await s.keeper.round();
    expect(s.wanted()).not.toBeNull();
  });

  it('puts the node key in the bundle', async () => {
    /* One company: a second app beside it would open a whole second database for its config alone. */
    const s = await stand({ secrets: () => bundleSecrets(s.config, { HORNHOOF_NODE_KEY: 'n'.repeat(40) }) });
    const base = { HORNHOOF_SECRET: s.config.secret.toString('base64'), RELAY_URL: s.config.relayUrl };
    expect(bundleSecrets(s.config, { HORNHOOF_NODE_KEY: 'n'.repeat(40) })).toEqual({ ...base, NODE_KEY: 'n'.repeat(40) });
    expect(bundleSecrets(s.config, { HORNHOOF_NODE_KEY: '' })).toEqual({ ...base, NODE_KEY: '' });
    expect(bundleSecrets(s.config, {})).toEqual({ ...base, NODE_KEY: '' });
    expect((await s.opened(await s.bundle())).secrets.NODE_KEY).toBe('n'.repeat(40));
  });

  it('keeps its latest two and what holders still fetch', async () => {
    const s = await stand();
    const ids: string[] = [];
    for (let made = 0; made < 4; made += 1) {
      ids.push(await s.bundle());
      /* The app names the first one for a machine that has not fetched it yet. */
      s.said.holders = { [ids[0]!]: [randomUUID()] };
      s.advance(BUNDLE_EVERY_MS);
    }
    expect(s.keeper.held()).toEqual([ids[3], ids[2], ids[0]]);
    s.said.holders = null;
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([ids[3], ids[2]]);
  });

  it("opens the bundle its app orders restored, and keeps it however old it is", async () => {
    const s = await stand();
    const ids: string[] = [];
    for (let made = 0; made < 3; made += 1) {
      ids.push(await s.bundle());
      s.advance(BUNDLE_EVERY_MS);
    }
    expect(s.keeper.held()).toEqual([ids[2], ids[1]]);
    /* The app orders the newest but one restored, and two more are made meanwhile: it stays. */
    const held = s.keeper.store().list().find(bundle => bundle.id === ids[1])!.manifest;
    const order = { attempt: randomUUID(), id: ids[1], dumpedAt: held.dumpedAt, source: 'store', identity: null, expect: { sha256: held.sha256, size: held.size, signer: held.signer }, company: s.acme.id, authorityPem: s.held.authorityPem, carry: true };
    s.said.order = order;
    await s.keeper.round();
    const asked = join(s.controlDir, 'restore.json');
    await until(() => existsSync(asked));
    expect(JSON.parse(readFileSync(asked, 'utf8'))).toEqual({ attempt: order.attempt, id: ids[1], dumpedAt: held.dumpedAt, carry: true });
    expect(readFileSync(join(s.controlDir, 'restore', `${order.attempt}.sql.gz`)).equals(DUMP)).toBe(true);
    for (let made = 0; made < 2; made += 1) {
      ids.push(await s.bundle());
      s.advance(BUNDLE_EVERY_MS);
    }
    expect(s.keeper.held()).toEqual([ids[4], ids[3], ids[1]]);
    /* No line of the keeper holds the order. */
    expect(s.lines.filter(line => line.includes(order.attempt) || line.includes('authorityPem'))).toEqual([]);
  });

  it('makes the fork bundle first', async () => {
    const s = await stand();
    const fork = randomUUID();
    const database = 'hornhoof_before_20261110_090000';
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES (${`kept:${database}`}, 'a database', ${fork})`);
    /* A timer dump is due as well, as on a server that was just restored. */
    await s.keeper.round();
    expect(JSON.parse(readFileSync(s.request, 'utf8'))).toEqual({ id: fork, database, reason: 'fork' });
    /* The updater dumps that database, and says so. */
    s.dumped(fork, { reason: 'fork' });
    rmSync(s.request);
    await s.keeper.round();
    const [recorded] = await bundleRows(s.db, { limit: 5 });
    expect(recorded).toMatchObject({ id: fork, reason: 'fork' });
    expect((await s.opened(fork)).manifest.reason).toBe('fork');
    expect(s.waiting()).toEqual([]);
    /* Then the dump that was due, of the database in use. */
    await s.keeper.round();
    expect(JSON.parse(readFileSync(s.request, 'utf8'))).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(s.wanted()).not.toBe(fork);
  });

  it('asks for a fork again only after a while when its dump failed', async () => {
    const s = await stand();
    const fork = randomUUID();
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', ${fork})`);
    await s.keeper.round();
    expect(s.wanted()).toBe(fork);
    mkdirSync(s.dumps, { recursive: true });
    writeFileSync(join(s.dumps, `${fork}.failed`), 'The database could not be dumped.\n');
    rmSync(s.request);
    await s.keeper.round();
    expect(s.lines.at(-1)).toBe('The updater could not dump the database for a backup: The database could not be dumped.');
    /* The timer dump goes on meanwhile, and the fork is asked for again once the gap is over. */
    expect(s.wanted()).not.toBe(fork);
    s.updater();
    await s.keeper.round();
    s.advance(DUMP_GAP_MS);
    await s.keeper.round();
    expect(s.wanted()).toBe(fork);
  });

  it('records a fork again until it is recorded', async () => {
    const s = await stand();
    const fork = randomUUID();
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', ${fork})`);
    await s.keeper.round();
    s.dumped(fork, { reason: 'fork' });
    rmSync(s.request);
    s.said.record = 503;
    await s.keeper.round();
    expect([s.keeper.held(), await bundleRows(s.db, { limit: 5 })]).toEqual([[fork], []]);
    /* The dump is gone by its day, and the app still has no record: the stored head goes again, with no new dump. */
    s.advance(DUMP_LIFE_MS);
    await s.keeper.round();
    expect(s.waiting().filter(name => name.startsWith(fork))).toEqual([]);
    s.said.record = null;
    const before = s.asked.length;
    await s.keeper.round();
    expect(s.asked.slice(before)).toContain('POST /api/network/backups');
    expect((await bundleRows(s.db, { limit: 5 })).map(row => row.id)).toContain(fork);
    expect(s.wanted()).not.toBe(fork);
    const after = s.asked.length;
    await s.keeper.round();
    await s.keeper.round();
    expect(s.asked.slice(after).filter(line => line.startsWith('POST'))).toEqual([]);
  });

  it('keeps fork bundles 30 days', async () => {
    const s = await stand();
    const fork = randomUUID();
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', ${fork})`);
    await s.keeper.round();
    s.dumped(fork, { reason: 'fork' });
    rmSync(s.request);
    await s.keeper.round();
    const madeAt = s.now();
    const timers: string[] = [];
    for (let made = 0; made < 3; made += 1) {
      timers.push(await s.bundle());
      s.advance(BUNDLE_EVERY_MS);
    }
    /* The latest two of the timer's, and the fork outside that count. */
    expect(s.keeper.held()).toEqual([timers[2], timers[1], fork]);
    s.advance(madeAt + FORK_KEEP_MS - s.now() - 1000);
    await s.keeper.round();
    expect(s.keeper.held()).toContain(fork);
    s.advance(2000);
    await s.keeper.round();
    expect(s.keeper.held()).not.toContain(fork);
  });

  it('reports every fork it holds', async () => {
    const s = await stand();
    const fork = randomUUID();
    await s.db.execute(sql`INSERT INTO net.merges (source, label, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', ${fork})`);
    await s.keeper.round();
    s.dumped(fork, { reason: 'fork' });
    rmSync(s.request);
    await s.keeper.round();
    /* Seventeen newer bundles, all still named by the app for machines that hold them. The app is made to say there is
       none yet, so one is due each time, ten minutes apart: it records none that is a day from its own clock. */
    const newer: string[] = [];
    const holders: Record<string, string[]> = {};
    s.said.last = null;
    for (let made = 0; made < 17; made += 1) {
      s.advance(DUMP_GAP_MS);
      const id = await s.bundle();
      newer.push(id);
      holders[id] = [randomUUID()];
      s.said.holders = { ...holders };
    }
    await s.keeper.round();
    expect(s.keeper.held()).toHaveLength(18);
    const reported = s.keeper.reported();
    expect(reported).toHaveLength(REPORTED_BUNDLES + 1);
    expect(reported.slice(0, REPORTED_BUNDLES)).toEqual([...newer].reverse().slice(0, REPORTED_BUNDLES));
    expect(reported.at(-1)).toBe(fork);
    expect(REPORT_MAX).toBe(32);
  });

  it('makes a bundle at once after the company was restored to an earlier time', async () => {
    const s = await stand();
    const first = await s.bundle();
    s.advance(MINUTE);
    const file = JSON.parse(((await s.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    const second = await s.bundle();
    /* The ten minutes are far from over, and it asked for a dump for this recovery key already. */
    s.advance(MINUTE);
    await s.keeper.round();
    expect(s.wanted()).toBeNull();
    /* The company is restored from the second bundle: its records end before that bundle, as the database it was made
       from did. The key is the company's still, and nothing of the restored company is backed up for it. */
    const before = (await bundleRows(s.db)).find(row => row.id === first)!;
    s.said.last = { id: first, madeAt: before.madeAt, recovery: null };
    await s.keeper.round();
    expect(s.wanted()).not.toBeNull();
    expect(s.wanted()).not.toBe(second);
    void file;
  });

  it('takes the bundle of a database that led from the machine that sealed it', async () => {
    const s = await stand();
    await s.keeper.round();
    const authority = (await authorityOf(s.db, s.config))!;
    /* B holds the data and led before: its keeper sealed what its database held, signed with its own certificate. */
    const b = await s.worker('studio', { role: 'data' });
    const bKey = machineKey();
    const issued = await issueCertificate(authority, { machineId: b, role: 'data', signKey: bKey.publicPem });
    await s.db.insert(certificates).values({ serial: issued.serial, machineId: b, until: issued.until });
    const held = { machine: b, role: 'data' as const, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
    const peer = (machine: string): Peer => ({ machine, role: 'data', serial: issued.serial, until: issued.until, address: '127.0.0.1' });
    const led = await s.head({ key: bKey, held, reason: 'fork' });
    /* From another machine's certificate it is refused, and nothing of it stays. */
    const c = await s.worker('laptop', { role: 'data' });
    expect(await s.keeper.takeLed(peer(c), led.id, Readable.from([led.travels()]))).toBe(403);
    expect(s.keeper.store().has(led.id)).toBe(false);
    /* From the machine that signed it: stored, and recorded with the app under that machine's name. */
    expect(await s.keeper.takeLed(peer(b), led.id, Readable.from([led.travels()]))).toBe(201);
    expect([s.keeper.store().has(led.id), (await bundleRow(s.db, led.id))?.id]).toEqual([true, led.id]);
    /* Sent again, it is there already. */
    expect(await s.keeper.takeLed(peer(b), led.id, Readable.from([led.travels()]))).toBe(200);
    /* A bundle that is no fork, or one cut short, is not taken. */
    const timer = await s.head({ key: bKey, held });
    expect(await s.keeper.takeLed(peer(b), timer.id, Readable.from([timer.travels()]))).toBe(403);
    const cut = await s.head({ key: bKey, held, reason: 'fork' });
    expect(await s.keeper.takeLed(peer(b), cut.id, Readable.from([cut.travels().subarray(0, 600)]))).toBe(400);
    expect([s.keeper.store().has(timer.id), s.keeper.store().has(cut.id)]).toEqual([false, false]);
    /* It stays through the rounds that keep only what is still needed. */
    await s.keeper.round();
    expect(s.keeper.store().has(led.id)).toBe(true);
  });

  /* B, a machine that holds the data and led before, with a certificate of its own, and a fork it sealed that the
     server's keeper took from it. */
  async function ledFrom(s: Awaited<ReturnType<typeof stand>>) {
    await s.keeper.round();
    const authority = (await authorityOf(s.db, s.config))!;
    const b = await s.worker('studio', { role: 'data' });
    const key = machineKey();
    const issued = await issueCertificate(authority, { machineId: b, role: 'data', signKey: key.publicPem });
    await s.db.insert(certificates).values({ serial: issued.serial, machineId: b, until: issued.until });
    const held = { machine: b, role: 'data' as const, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
    const peer = (machine: string): Peer => ({ machine, role: 'data', serial: issued.serial, until: issued.until, address: '127.0.0.1' });
    const fork = () => s.head({ key, held, reason: 'fork' });
    const led = await fork();
    expect(await s.keeper.takeLed(peer(b), led.id, Readable.from([led.travels()]))).toBe(201);
    return { b, peer, fork, led };
  }

  it('gives a bundle it holds to no machine but its signer', async () => {
    const s = await stand();
    const own = await s.bundle();
    const { b, peer, led } = await ledFrom(s);
    const records = () => s.asked.filter(call => call === 'POST /api/network/backups').length;
    const before = records();
    /* Another machine that holds the data sends a bundle under the id of one held here: B's fork, or the server's own
       bundle. It is refused here, the app is not asked to record it under that machine's name, and both stay. */
    const c = await s.worker('laptop', { role: 'data' });
    expect(await s.keeper.takeLed(peer(c), led.id, Readable.from([led.travels()]))).toBe(403);
    expect(await s.keeper.takeLed(peer(c), own, Readable.from([led.travels()]))).toBe(403);
    expect(await s.keeper.takeLed(peer(b), own, Readable.from([led.travels()]))).toBe(403);
    expect(records()).toBe(before);
    expect([s.keeper.store().has(led.id), s.keeper.store().has(own)]).toEqual([true, true]);
    /* Its signer sends it again, and it is recorded as before. */
    expect(await s.keeper.takeLed(peer(b), led.id, Readable.from([led.travels()]))).toBe(200);
    expect([s.keeper.store().has(led.id), s.keeper.store().has(own), (await bundleRow(s.db, led.id))?.id]).toEqual([true, true, led.id]);
  });

  it('keeps a bundle it held whatever the app answers, and drops only one the refused request brought', async () => {
    const s = await stand();
    const { b, peer, fork, led } = await ledFrom(s);
    /* Its signer sends it again and the app refuses the record: the answer is the app's, and the bundle stays. */
    for (const status of [400, 403, 409]) {
      s.said.record = status;
      expect(await s.keeper.takeLed(peer(b), led.id, Readable.from([led.travels()]))).toBe(status);
      expect(s.keeper.store().has(led.id)).toBe(true);
    }
    /* A bundle this very request brought, which the app would not have: nothing of it stays. */
    const fresh = await fork();
    s.said.record = 400;
    expect(await s.keeper.takeLed(peer(b), fresh.id, Readable.from([fresh.travels()]))).toBe(400);
    expect([s.keeper.store().has(fresh.id), s.keeper.store().has(led.id)]).toEqual([false, true]);
  });

  it('never lets a refused delivery of a new bundle remove the copy another delivery of it got recorded', async () => {
    const s = await stand();
    const { b, peer, fork } = await ledFrom(s);
    /* Two deliveries of one new fork at once: the second has not sent its bundle yet when the first is recorded, and
       then B's certificate is revoked, so the app refuses the second. The copy the first brought and its record stay. */
    const fresh = await fork();
    const first = s.keeper.takeLed(peer(b), fresh.id, Readable.from([fresh.travels()]));
    const later = new PassThrough();
    const second = s.keeper.takeLed(peer(b), fresh.id, later);
    expect(await first).toBe(201);
    await s.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.machineId, b));
    later.end(fresh.travels());
    expect(await second).toBe(403);
    expect([s.keeper.store().has(fresh.id), (await bundleRow(s.db, fresh.id))?.id]).toEqual([true, fresh.id]);
  });

  it('gives two deliveries of one new bundle at once one copy, recorded once', async () => {
    const s = await stand();
    const { b, peer, fork } = await ledFrom(s);
    const fresh = await fork();
    const later = new PassThrough();
    const answers = Promise.all([s.keeper.takeLed(peer(b), fresh.id, Readable.from([fresh.travels()])), s.keeper.takeLed(peer(b), fresh.id, later)]);
    later.end(fresh.travels());
    expect((await answers).sort()).toEqual([200, 201]);
    expect([s.keeper.store().has(fresh.id), (await bundleRow(s.db, fresh.id))?.id]).toEqual([true, fresh.id]);
    expect(readdirSync(join(s.dir, BUNDLES_DIR)).filter(name => name.startsWith(fresh.id)).sort()).toEqual([`${fresh.id}.age`, `${fresh.id}.head`]);
  });

  it('makes nothing while it does not lead', async () => {
    const s = await stand();
    s.said.leads = false;
    await s.keeper.round();
    expect([s.wanted(), s.asked]).toEqual([null, []]);
    /* Nor without a certificate that says this machine holds the data, or before the company is set up. */
    const worker = new BackupKeeper({
      dir: s.dir, controlDir: s.controlDir, key: s.key, held: () => ({ ...s.held, role: 'worker' }), age: { identity: s.ownIdentity, recipient: s.ownAge }, secrets: () => SECRETS,
      ask: async (method, path) => ({ status: 200, body: (await s.app.inject({ method, url: path, ...OWN })).json() }), leads: () => true, log: () => undefined,
    });
    await worker.round();
    expect(s.wanted()).toBeNull();
    expect(worker.view()).toMatchObject({ company: s.acme.id });
  });

  it('stops at once while its app does not answer', async () => {
    const s = await stand();
    /* An app that answers nothing, as one that hangs: the ask ends only when its keeper stops. */
    const silent: Ask = (_method, _path, _body, stop) => new Promise((_resolve, reject) => stop?.addEventListener('abort', () => reject(new Error('the keeper stopped')), { once: true }));
    const keeper = new BackupKeeper({
      dir: s.dir, controlDir: s.controlDir, key: s.key, held: () => s.held, age: { identity: s.ownIdentity, recipient: s.ownAge }, secrets: () => SECRETS,
      ask: silent, leads: () => true, log: () => undefined,
    });
    /* The clock stands still from here: a stop that waited for any time to pass would never end. */
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const round = keeper.round();
    await keeper.stop();
    await round;
  });
});
