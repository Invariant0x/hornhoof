import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.js';
import { companies, linkTls } from '../src/db/schema.js';
import { AppMode } from '../src/modules/keeper/app-mode.js';
import { Settings } from '../src/modules/link/tunnel.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { AcmeError } from '../src/modules/tls/acme.js';
import { certId, type RenewalWindow } from '../src/modules/tls/ari.js';
import { failureFields, LinkTls, nextOrderTry, renewalPlan, wantedMode, type Acme, type Served } from '../src/modules/tls/manager.js';
import { tlsOf, updateTls } from '../src/modules/tls/store.js';
import { certInfo, selfSigned } from '../src/modules/tls/x509.js';
import { fakeRelay } from './fake-relay.js';
import { appOn, as, SETUP, setUpCompany, testApp, TUNNEL, until } from './helpers.js';

const DIRECTORY = 'https://acme.invalid/directory';
const OTHER_DIRECTORY = 'https://other.invalid/directory';
const HOST = 'acme.hornhoof.test';
const GLOBEX = 'globex.hornhoof.test';
const ERROR_TYPE = 'urn:ietf:params:acme:error:';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/* A busy machine may take a while to end a pass, and only a failure waits this long. */
const PASS_MS = 20 * SECOND;

type Used = Parameters<Served['use']>;

/* What stands in for the CA, its renewal information, the probe through the link and the listener. A restart keeps them. */
function fakes(clock: { now: number }, challenges: () => { get(token: string): string | undefined }) {
  const seen = {
    made: [] as { directory: string; accountKeyPem: string; accountUrl: string | null }[],
    accounts: 0,
    issues: [] as { host: string; replaces: string | undefined }[],
    answered: [] as (string | undefined)[],
    asked: [] as { directory: string; certPem: string }[],
    probes: [] as { url: string; certPem: string }[],
    used: [] as Used[],
  };
  const set = {
    /* Thrown by every issue while it is set, after those in failOnce. */
    failing: null as Error | null,
    failOnce: [] as Error[],
    certHost: null as string | null,
    renewal: null as RenewalWindow | null | Error,
    probeAnswer: true,
    onProbe: (): void => {},
    useFails: false,
    onIssue: async (): Promise<unknown> => undefined,
  };
  const acme = (directory: string, accountKeyPem: string, accountUrl: string | null): Acme => {
    seen.made.push({ directory, accountKeyPem, accountUrl });
    return {
      account: async () => `https://acme.invalid/account/${++seen.accounts}`,
      issue: async (host, hooks, { replaces } = {}) => {
        seen.issues.push({ host, replaces });
        await set.onIssue();
        hooks.answer('tok', 'tok.ka');
        seen.answered.push(challenges().get('tok'));
        hooks.forget('tok');
        const failure = set.failOnce.shift() ?? set.failing;
        if (failure) throw failure;
        return selfSigned(set.certHost ?? host, { days: 90, now: new Date(clock.now) });
      },
    };
  };
  const renewalInfo = async (directory: string, certPem: string) => {
    seen.asked.push({ directory, certPem });
    if (set.renewal instanceof Error) throw set.renewal;
    return set.renewal;
  };
  const probe = async (url: string, certPem: string) => {
    seen.probes.push({ url, certPem });
    set.onProbe();
    return set.probeAnswer;
  };
  const listener: Served = {
    use: async (host, cert) => {
      if (set.useFails) throw new Error('the listener refuses');
      seen.used.push([host, cert]);
    },
  };
  return { seen, set, acme, renewalInfo, probe, listener };
}

/* A company with the link acme and a LinkTls on fakes, on a clock the test moves. The clock starts now, whole seconds as a
   certificate's dates are, since the tunnel's file is written by the real clock. */
async function stage(env: NodeJS.ProcessEnv = {}) {
  const relay = await fakeRelay();
  const control = mkdtempSync(join(tmpdir(), 'hh-link-tls-'));
  onTestFinished(() => rmSync(control, { recursive: true, force: true }));
  const fullEnv = { ACME_DIRECTORY: DIRECTORY, RELAY_URL: relay.url, TUNNEL_HOST: TUNNEL, HORNHOOF_CONTROL_DIR: control, ...env };
  const { app, db, config } = await testApp(fullEnv);
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const start = Math.floor(Date.now() / SECOND) * SECOND;
  const clock = { now: start };
  const { seen, set, acme, renewalInfo, probe, listener } = fakes(clock, () => app.ctx.challenges);
  await app.ctx.links.set(companyId, 'acme');
  const opts = { acme, renewalInfo, probe, now: () => clock.now, random: () => 0.5 };
  const serving = async (ctx = app.ctx) => {
    const tls = new LinkTls(ctx, opts);
    await tls.serveOn(listener);
    return tls;
  };
  const tunnelFile = join(control, 'tunnel.json');
  return {
    app,
    db,
    config,
    relay,
    ceo,
    companyId,
    fullEnv,
    start,
    clock,
    seen,
    set,
    opts,
    listener,
    tunnelFile,
    tls: await serving(),
    /* A LinkTls as a restart makes it. */
    serving,
    move: (ms: number) => void (clock.now += ms),
    row: async () => (await tlsOf(db, companyId))!,
    /* Read as the tunnel container reads it. */
    tunnelMode: () => Settings.parse(JSON.parse(readFileSync(tunnelFile, 'utf8'))).mode,
  };
}

const windowOf = (start: number, end: number, retryAfterS = 21600): RenewalWindow => ({ start: new Date(start), end: new Date(end), retryAfterS });

describe('renewalPlan', () => {
  const NOW = Date.parse('2030-01-10T00:00:00.000Z');
  const cert = { notBefore: new Date('2030-01-01T00:00:00.000Z'), notAfter: new Date('2030-04-01T00:00:00.000Z') };
  const half = () => 0.5;
  const at = (iso: string) => new Date(iso);
  const window = windowOf(Date.parse('2030-02-01T00:00:00.000Z'), Date.parse('2030-02-03T00:00:00.000Z'));

  it('keeps a renewal time the window still holds, either edge too', () => {
    for (const iso of ['2030-02-01T00:00:00.000Z', '2030-02-01T07:00:00.000Z', '2030-02-03T00:00:00.000Z']) {
      expect(renewalPlan(window, { ...cert, renewAt: at(iso) }, NOW, half).renewAt, iso).toEqual(at(iso));
    }
  });

  it('draws a time in the window when it moved away, or there was none', () => {
    const middle = at('2030-02-02T00:00:00.000Z');
    expect(renewalPlan(window, { ...cert, renewAt: at('2030-01-31T23:59:59.000Z') }, NOW, half).renewAt).toEqual(middle);
    expect(renewalPlan(window, { ...cert, renewAt: at('2030-02-03T00:00:01.000Z') }, NOW, half).renewAt).toEqual(middle);
    expect(renewalPlan(window, { ...cert, renewAt: null }, NOW, half).renewAt).toEqual(middle);
    expect(renewalPlan(window, { ...cert, renewAt: null }, NOW, () => 0).renewAt).toEqual(at('2030-02-01T00:00:00.000Z'));
  });

  it('renews now when the window has passed', () => {
    const passed = windowOf(NOW - 2 * DAY, NOW);
    expect(renewalPlan(passed, { ...cert, renewAt: null }, NOW, half).renewAt).toEqual(new Date(NOW));
    expect(renewalPlan(passed, { ...cert, renewAt: at('2030-02-02T00:00:00.000Z') }, NOW, half).renewAt).toEqual(new Date(NOW));
  });

  it('asks again after the Retry-After, between an hour and a day', () => {
    const askAfter = (retryAfterS: number) => renewalPlan({ ...window, retryAfterS }, { ...cert, renewAt: null }, NOW, half).askAt.getTime() - NOW;
    expect(askAfter(60)).toBe(HOUR);
    expect(askAfter(7200)).toBe(2 * HOUR);
    expect(askAfter(7 * 86400)).toBe(DAY);
  });

  it('without renewal information keeps the time or takes two thirds of the lifetime, and asks in six hours', () => {
    const twoThirds = at('2030-03-02T00:00:00.000Z');
    expect(renewalPlan(null, { ...cert, renewAt: null }, NOW, half)).toEqual({ renewAt: twoThirds, askAt: new Date(NOW + 6 * HOUR) });
    expect(renewalPlan(null, { ...cert, renewAt: at('2030-02-02T00:00:00.000Z') }, NOW, half).renewAt).toEqual(at('2030-02-02T00:00:00.000Z'));
  });

  it('after an error does the same, and asks in an hour', () => {
    expect(renewalPlan('error', { ...cert, renewAt: null }, NOW, half)).toEqual({ renewAt: at('2030-03-02T00:00:00.000Z'), askAt: new Date(NOW + HOUR) });
  });
});

describe('wantedMode', () => {
  const NOW = Date.parse('2030-01-10T00:00:00.000Z');
  const up = { up: true, relayStarted: 1, passthrough: true };
  const facts = { rowMode: 'http' as const, canServe: true, health: up, blockedUntil: null };

  it('is https only with a certificate that can serve, and a relay that passes TLS through', () => {
    expect(wantedMode(facts, NOW)).toBe('https');
    expect(wantedMode({ ...facts, canServe: false }, NOW)).toBe('http');
    expect(wantedMode({ ...facts, health: { ...up, passthrough: false }, rowMode: 'https' }, NOW)).toBe('http');
  });

  it('waits out the block, and no longer', () => {
    expect(wantedMode({ ...facts, blockedUntil: new Date(NOW + 1) }, NOW)).toBe('http');
    expect(wantedMode({ ...facts, blockedUntil: new Date(NOW) }, NOW)).toBe('https');
  });

  it('keeps the mode while the relay is unknown, except when the certificate cannot serve', () => {
    const down = { up: false, relayStarted: null, passthrough: false };
    for (const rowMode of ['http', 'https'] as const) {
      expect(wantedMode({ ...facts, rowMode, health: null }, NOW)).toBe(rowMode);
      expect(wantedMode({ ...facts, rowMode, health: down }, NOW)).toBe(rowMode);
      expect(wantedMode({ ...facts, rowMode, health: null, canServe: false }, NOW)).toBe('http');
    }
  });
});

describe('nextOrderTry', () => {
  const refused = (name: string) => new AcmeError('refused', { type: `${ERROR_TYPE}${name}` });

  it('finds the account again when the CA no longer knows it, keeping replaces', () => {
    expect(nextOrderTry(refused('accountDoesNotExist'), { accountUrl: 'https://u', replaces: 'id' })).toEqual({ accountUrl: null, replaces: 'id' });
  });

  it('orders without replaces after a refusal of one sent with it', () => {
    expect(nextOrderTry(refused('alreadyReplaced'), { accountUrl: 'https://u', replaces: 'id' })).toEqual({ accountUrl: 'https://u', replaces: null });
    expect(nextOrderTry(new AcmeError('refused'), { accountUrl: 'https://u', replaces: 'id' })).toEqual({ accountUrl: 'https://u', replaces: null });
  });

  it('stops at anything else, so an order is tried a bounded number of times', () => {
    const cases: [Error, { accountUrl: string | null; replaces: string | null }][] = [
      [refused('rateLimited'), { accountUrl: 'https://u', replaces: 'id' }],
      [refused('accountDoesNotExist'), { accountUrl: null, replaces: null }],
      [refused('malformed'), { accountUrl: 'https://u', replaces: null }],
      [new AcmeError('invalid'), { accountUrl: 'https://u', replaces: 'id' }],
      [new AcmeError('unreachable'), { accountUrl: 'https://u', replaces: 'id' }],
      [new AcmeError('not_ready'), { accountUrl: 'https://u', replaces: 'id' }],
      [new Error('something else'), { accountUrl: 'https://u', replaces: 'id' }],
    ];
    for (const [err, tried] of cases) expect(nextOrderTry(err, tried), err.message).toBeNull();
  });
});

describe('failureFields', () => {
  const NOW = Date.parse('2030-01-10T00:00:00.000Z');

  it('waits five minutes after its own check, and at least an hour after anything else', () => {
    expect(failureFields(new AcmeError('not_ready'), NOW)).toEqual({ nextTryAt: new Date(NOW + 5 * MINUTE), failure: 'not_ready', failedAt: new Date(NOW) });
    expect(failureFields(new AcmeError('invalid'), NOW).nextTryAt).toEqual(new Date(NOW + HOUR));
    expect(failureFields(new AcmeError('refused', { retryAfterS: 60 }), NOW).nextTryAt).toEqual(new Date(NOW + HOUR));
    expect(failureFields(new AcmeError('refused', { retryAfterS: 7200 }), NOW).nextTryAt).toEqual(new Date(NOW + 2 * HOUR));
  });

  it('names the failure by its type, or else its kind', () => {
    expect(failureFields(new AcmeError('refused', { type: `${ERROR_TYPE}rateLimited` }), NOW).failure).toBe(`${ERROR_TYPE}rateLimited`);
    expect(failureFields(new AcmeError('unreachable'), NOW).failure).toBe('unreachable');
  });
});

describe('ordering the certificate', () => {
  it("orders the link's first certificate and keeps its key encrypted", async () => {
    const w = await stage();
    await w.tls.tick();
    expect(w.seen.issues).toEqual([{ host: HOST, replaces: undefined }]);
    expect(w.seen.answered).toEqual(['tok.ka']);
    expect(w.app.ctx.challenges.get('tok')).toBeUndefined();
    const row = await w.row();
    expect(certInfo(row.certPem!).names).toEqual([HOST]);
    const sealed = decryptSecret(row.certKeyEnc!, w.config.secret);
    expect(new X509Certificate(row.certPem!).checkPrivateKey(createPrivateKey(sealed))).toBe(true);
    expect(row.certKeyEnc!.includes('PRIVATE KEY')).toBe(false);
    expect(row.accountKeyEnc.includes('PRIVATE KEY')).toBe(false);
    expect(decryptSecret(row.accountKeyEnc, w.config.secret).includes('PRIVATE KEY')).toBe(true);
    expect(row.accountUrl).toBe('https://acme.invalid/account/1');
    expect(row).toMatchObject({ name: 'acme', certDirectory: DIRECTORY, directory: DIRECTORY, renewAt: new Date(w.start + 60 * DAY), nextTryAt: null, failure: null, failedAt: null });
    expect(row.notAfter).toEqual(new Date(w.start + 90 * DAY));
  });

  it('does nothing without a link, or when certificates are off', async () => {
    const w = await stage();
    await w.app.ctx.links.remove(w.companyId);
    w.relay.calls.length = 0;
    await w.tls.tick();
    expect(w.seen.issues).toEqual([]);
    expect(w.relay.calls).toEqual([]);
    expect(await tlsOf(w.db, w.companyId)).toBeNull();

    const off = await stage({ ACME_DIRECTORY: 'off' });
    off.relay.calls.length = 0;
    off.tls.start();
    onTestFinished(() => off.tls.stop());
    off.tls.kick();
    await off.tls.tick();
    expect(off.seen.issues).toEqual([]);
    expect(off.relay.calls).toEqual([]);
    expect(await tlsOf(off.db, off.companyId)).toBeNull();
  });

  it('waits an hour after a failed order, and longer when the CA says so', async () => {
    const w = await stage();
    w.set.failing = new AcmeError('refused', { type: `${ERROR_TYPE}rateLimited`, retryAfterS: 7200 });
    await w.tls.tick();
    expect(await w.row()).toMatchObject({ failure: `${ERROR_TYPE}rateLimited`, failedAt: new Date(w.start), nextTryAt: new Date(w.start + 2 * HOUR) });
    expect(w.seen.issues).toHaveLength(1);
    w.move(HOUR);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(1);
    w.set.failing = new AcmeError('invalid');
    w.move(HOUR + SECOND);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
    expect((await w.row()).failure).toBe('invalid');
    w.move(HOUR - 2 * SECOND);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
    w.move(3 * SECOND);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(3);
  });

  it('waits five minutes when its own check of the challenge fails', async () => {
    const w = await stage();
    w.set.failing = new AcmeError('not_ready');
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(1);
    expect((await w.row()).failure).toBe('not_ready');
    w.move(4 * MINUTE);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(1);
    w.move(MINUTE + SECOND);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
  });

  it('says a failure in one line, with its kind and type only', async () => {
    const w = await stage();
    const warn = vi.spyOn(w.app.ctx.log, 'warn');
    w.set.failing = new AcmeError('refused', { type: `${ERROR_TYPE}rateLimited`, detail: 'what the CA said' });
    await w.tls.tick();
    expect(warn.mock.calls).toEqual([[{ kind: 'refused', type: `${ERROR_TYPE}rateLimited` }, expect.any(String)]]);
    expect(JSON.stringify(warn.mock.calls).includes('what the CA said')).toBe(false);
  });

  it('counts a chain that does not name the host as invalid, and reads names in any case', async () => {
    const w = await stage();
    w.set.certHost = 'other.hornhoof.test';
    await w.tls.tick();
    expect(await w.row()).toMatchObject({ failure: 'invalid', certPem: null, nextTryAt: new Date(w.start + HOUR) });
    w.set.certHost = 'ACME.hornhoof.test';
    w.move(HOUR + SECOND);
    await w.tls.tick();
    expect(certInfo((await w.row()).certPem!).names).toEqual(['ACME.hornhoof.test']);
    expect((await w.row()).failure).toBeNull();
    expect(w.tunnelMode()).toBe('https');
  });

  it('finds the account again when the CA answers that it no longer knows it', async () => {
    const w = await stage();
    await w.tls.tick();
    const old = await w.row();
    w.set.failOnce = [new AcmeError('refused', { type: `${ERROR_TYPE}accountDoesNotExist` })];
    await w.app.ctx.links.set(w.companyId, 'globex');
    w.seen.made.length = 0;
    await w.tls.tick();
    const accountKeyPem = decryptSecret(old.accountKeyEnc, w.config.secret);
    /* Booleans only: a failure here must not print a key. */
    expect(w.seen.made.map(made => made.accountKeyPem === accountKeyPem)).toEqual([true, true]);
    expect(w.seen.made.map(made => made.accountUrl)).toEqual(['https://acme.invalid/account/1', null]);
    expect(w.seen.issues.slice(1).map(issue => issue.host)).toEqual([GLOBEX, GLOBEX]);
    expect(await w.row()).toMatchObject({ accountUrl: 'https://acme.invalid/account/2', name: 'globex', failure: null });
  });

  it('runs one pass at a time', async () => {
    const w = await stage();
    await Promise.all([w.tls.tick(), w.tls.tick()]);
    expect(w.seen.issues).toHaveLength(1);
  });
});

describe('renewing the certificate', () => {
  it('renews inside the window the CA suggests, replacing the old certificate', async () => {
    const w = await stage();
    w.set.renewal = windowOf(w.start + 10 * DAY, w.start + 12 * DAY);
    await w.tls.tick();
    const old = await w.row();
    expect(old.renewAt).toEqual(new Date(w.start + 11 * DAY));
    w.move(10 * DAY);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(1);
    w.move(DAY);
    await w.tls.tick();
    expect(w.seen.issues).toEqual([
      { host: HOST, replaces: undefined },
      { host: HOST, replaces: certId(old.certPem!)! },
    ]);
    expect((await w.row()).notAfter).toEqual(new Date(w.start + 101 * DAY));
  });

  it('renews at two thirds of the lifetime without renewal information', async () => {
    const w = await stage();
    await w.tls.tick();
    expect((await w.row()).renewAt).toEqual(new Date(w.start + 60 * DAY));
    expect(w.seen.asked.map(asked => asked.directory)).toEqual([DIRECTORY]);
  });

  it('asks the CA again after its Retry-After, between an hour and a day', async () => {
    const w = await stage();
    w.set.renewal = windowOf(w.start + 10 * DAY, w.start + 12 * DAY, 60);
    await w.tls.tick();
    expect((await w.row()).askAt).toEqual(new Date(w.start + HOUR));
    w.set.renewal = windowOf(w.start + 10 * DAY, w.start + 12 * DAY, 7 * 86400);
    w.move(HOUR);
    await w.tls.tick();
    expect(w.seen.asked).toHaveLength(2);
    expect((await w.row()).askAt).toEqual(new Date(w.start + HOUR + DAY));
    w.move(HOUR);
    await w.tls.tick();
    expect(w.seen.asked).toHaveLength(2);
  });

  it('orders once more without replaces when the CA will not take it', async () => {
    const w = await stage();
    await w.tls.tick();
    const old = await w.row();
    w.set.failOnce = [new AcmeError('refused', { type: `${ERROR_TYPE}alreadyReplaced` })];
    w.move(60 * DAY);
    await w.tls.tick();
    expect(w.seen.issues.slice(1)).toEqual([
      { host: HOST, replaces: certId(old.certPem!)! },
      { host: HOST, replaces: undefined },
    ]);
    expect((await w.row()).failure).toBeNull();
  });

  it('takes a rate limit on a renewal as it is, without a second order', async () => {
    const w = await stage();
    await w.tls.tick();
    w.set.failOnce = [new AcmeError('refused', { type: `${ERROR_TYPE}rateLimited` })];
    w.move(60 * DAY);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
    expect((await w.row()).failure).toBe(`${ERROR_TYPE}rateLimited`);
  });

  it('makes a new account when the CA changes', async () => {
    const w = await stage();
    await w.tls.tick();
    const old = await w.row();
    const moved = { ...w.app.ctx, config: { ...w.app.ctx.config, acmeDirectory: OTHER_DIRECTORY } };
    w.seen.made.length = 0;
    const accounts = w.seen.accounts;
    const tls = await w.serving(moved);
    await tls.tick();
    const row = await w.row();
    expect(row.directory).toBe(OTHER_DIRECTORY);
    expect(row.accountKeyEnc === old.accountKeyEnc).toBe(false);
    expect(row.certPem).toBe(old.certPem);
    expect(row.certDirectory).toBe(DIRECTORY);

    /* A restart in between, and the certificate is renewed only when due. */
    w.move(DAY);
    await tls.tick();
    const restarted = await w.serving(moved);
    await restarted.tick();
    expect(w.seen.issues).toHaveLength(1);
    w.move(60 * DAY);
    await restarted.tick();
    expect(w.seen.issues[1]).toEqual({ host: HOST, replaces: undefined });
    expect(w.seen.accounts).toBe(accounts + 1);
    expect(w.seen.made[0]!.directory).toBe(OTHER_DIRECTORY);
    expect(w.seen.made[0]!.accountUrl).toBeNull();
    expect((await w.row()).accountUrl).toBe(`https://acme.invalid/account/${accounts + 1}`);
    expect((await w.row()).certDirectory).toBe(OTHER_DIRECTORY);
  });
});

describe("the tunnel's mode", () => {
  it('moves the tunnel to https once the relay passes TLS through and the certificate is in', async () => {
    const w = await stage();
    w.relay.passthrough = true;
    await w.tls.tick();
    const row = await w.row();
    expect(row.mode).toBe('https');
    expect(w.tunnelMode()).toBe('https');
    expect(w.seen.probes).toEqual([{ url: `https://${HOST}`, certPem: row.certPem }]);
  });

  it('stays on http while the relay does not pass TLS through, and goes back when it stops', async () => {
    const w = await stage();
    w.relay.passthrough = false;
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
    expect(w.seen.probes).toEqual([]);

    w.relay.passthrough = true;
    w.move(9 * MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    w.move(MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
    expect(w.tunnelMode()).toBe('https');

    w.relay.passthrough = false;
    w.move(11 * MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
  });

  it('asks the relay once more before a switch, and stays when it stopped passing through', async () => {
    const w = await stage();
    await w.tls.tick();
    w.relay.passthrough = false;
    w.move(11 * MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    w.relay.passthrough = true;
    w.move(11 * MINUTE);
    const asking = vi.spyOn(w.app.ctx.links.relay, 'health');
    asking.mockResolvedValueOnce({ up: true, relayStarted: 1, passthrough: true });
    asking.mockResolvedValueOnce({ up: true, relayStarted: 1, passthrough: false });
    w.seen.probes.length = 0;
    await w.tls.tick();
    expect(asking).toHaveBeenCalledTimes(2);
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
    expect(w.seen.probes).toEqual([]);
  });

  it('keeps the mode while the relay does not answer', async () => {
    const w = await stage();
    await w.tls.tick();
    expect(w.tunnelMode()).toBe('https');
    w.relay.down = true;
    w.move(11 * MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
    expect(w.tunnelMode()).toBe('https');
  });

  it('goes back to http when the switch does not serve the certificate, and tries again an hour later', async () => {
    const w = await stage();
    w.set.probeAnswer = false;
    await w.tls.tick();
    expect(await w.row()).toMatchObject({ mode: 'http', httpsBlockedUntil: new Date(w.start + HOUR) });
    expect(w.tunnelMode()).toBe('http');
    expect(w.seen.probes).toHaveLength(1);

    w.move(30 * MINUTE);
    await w.tls.tick();
    expect(w.seen.probes).toHaveLength(1);
    expect(w.tunnelMode()).toBe('http');

    w.set.probeAnswer = true;
    w.move(31 * MINUTE);
    await w.tls.tick();
    expect(w.seen.probes).toHaveLength(2);
    expect((await w.row()).mode).toBe('https');
    expect(w.tunnelMode()).toBe('https');
  });

  it('gives the listener the certificate before it switches', async () => {
    const w = await stage();
    let lastUse: Used | undefined;
    w.set.onProbe = () => {
      lastUse = w.seen.used.at(-1);
    };
    await w.tls.tick();
    const row = await w.row();
    expect(lastUse?.[0]).toBe(HOST);
    expect(lastUse?.[1]?.certPem).toBe(row.certPem);
    expect(lastUse?.[1]?.keyPem === decryptSecret(row.certKeyEnc!, w.config.secret)).toBe(true);
  });

  it('stays on http while the listener will not take the certificate, and gives it again on the next pass', async () => {
    const w = await stage();
    const warn = vi.spyOn(w.app.ctx.log, 'warn');
    w.set.useFails = true;
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
    expect(w.seen.probes).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    w.set.useFails = false;
    await w.tls.tick();
    expect(w.seen.used.at(-1)?.[1]?.certPem).toBe((await w.row()).certPem);
    expect((await w.row()).mode).toBe('https');
  });

  it("goes down to http when the listener loses the name's certificate", async () => {
    const w = await stage();
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
    w.set.useFails = true;
    await w.tls.serveOn(w.listener);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
  });

  it("stays on http when the stored key is not the certificate's own", async () => {
    const w = await stage();
    w.relay.passthrough = false;
    await w.tls.tick();
    const other = await selfSigned(HOST);
    await updateTls(w.db, w.companyId, { certKeyEnc: encryptSecret(other.keyPem, w.config.secret) });
    w.relay.passthrough = true;
    w.move(11 * MINUTE);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.seen.probes).toEqual([]);
    expect(w.tunnelMode()).toBe('http');
  });

  it("probes https again after a restart, and keeps the hour's block", async () => {
    const w = await stage();
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
    w.seen.probes.length = 0;

    w.set.probeAnswer = false;
    await (await w.serving()).tick();
    expect(w.seen.probes).toHaveLength(1);
    expect(await w.row()).toMatchObject({ mode: 'http', httpsBlockedUntil: new Date(w.start + HOUR) });
    expect(w.tunnelMode()).toBe('http');

    w.set.probeAnswer = true;
    w.move(30 * MINUTE);
    const restarted = await w.serving();
    await restarted.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.seen.probes).toHaveLength(1);

    w.move(31 * MINUTE);
    await restarted.tick();
    expect((await w.row()).mode).toBe('https');
    expect(w.seen.probes).toHaveLength(2);
  });

  it('probes on the first pass after every start, and not on the passes after it', async () => {
    const w = await stage();
    await w.tls.tick();
    w.seen.probes.length = 0;
    const tls = await w.serving();
    tls.start();
    onTestFinished(() => tls.stop());
    await tls.tick();
    expect(w.seen.probes).toHaveLength(1);
    await tls.tick();
    expect(w.seen.probes).toHaveLength(1);
    tls.stop();
    tls.start();
    await tls.tick();
    expect(w.seen.probes).toHaveLength(2);
  });

  it("writes the tunnel's mode again after a failed write", async () => {
    const w = await stage();
    const sync = vi.spyOn(w.app.ctx.links, 'sync');
    w.set.probeAnswer = false;
    /* The switch's own write goes through, so the file says https; the write of the way back fails. */
    w.set.onProbe = () => void sync.mockResolvedValueOnce(false);
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('https');
    w.set.onProbe = () => {};
    await w.tls.tick();
    expect(w.tunnelMode()).toBe('http');
    const calls = sync.mock.calls.length;
    await w.tls.tick();
    expect(sync.mock.calls.length).toBe(calls);
  });

  it('goes back to http a day before the certificate ends', async () => {
    const w = await stage();
    await w.tls.tick();
    expect(w.tunnelMode()).toBe('https');

    /* Renewal failing for days: one try an hour at most, and the old certificate stays in. */
    w.set.failing = new AcmeError('unreachable');
    w.move(60 * DAY);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
    w.move(59 * MINUTE);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(2);
    w.move(2 * MINUTE);
    await w.tls.tick();
    expect(w.seen.issues).toHaveLength(3);

    w.clock.now = w.start + 90 * DAY - 25 * HOUR;
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
    w.clock.now = w.start + 90 * DAY - 23 * HOUR;
    await w.tls.tick();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
  });

  it('keeps https across a restart', async () => {
    const w = await stage();
    await w.tls.tick();
    expect(w.tunnelMode()).toBe('https');
    rmSync(w.tunnelFile);
    const calls = w.relay.calls.length;
    const { app } = await appOn((w.db as unknown as { $client: PGlite }).$client, w.fullEnv);
    await app.ready();
    expect(w.tunnelMode()).toBe('https');
    expect(w.relay.calls.length).toBe(calls);
  });

  it('orders anew for a renamed link, without replaces, on http until it is in', async () => {
    const w = await stage();
    await w.tls.tick();
    expect(w.tunnelMode()).toBe('https');
    await w.app.ctx.links.set(w.companyId, 'globex');
    expect(w.tunnelMode()).toBe('http');
    await w.tls.tick();
    expect(w.seen.issues[1]).toEqual({ host: GLOBEX, replaces: undefined });
    expect(certInfo((await w.row()).certPem!).names).toEqual([GLOBEX]);
  });

  it("switches a new name's certificate to https only through the probe", async () => {
    const w = await stage();
    await w.tls.tick();
    await w.app.ctx.links.set(w.companyId, 'globex');
    w.set.probeAnswer = false;
    w.seen.probes.length = 0;
    await w.tls.tick();
    const row = await w.row();
    expect(certInfo(row.certPem!).names).toEqual([GLOBEX]);
    expect(w.seen.probes).toEqual([{ url: `https://${GLOBEX}`, certPem: row.certPem }]);
    expect(row.mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
  });
});

describe('the listener', () => {
  it('serves the stored certificate, and a stand-in without one', async () => {
    const w = await stage();
    await w.tls.tick();
    const row = await w.row();
    const fresh: Used[] = [];
    const tls = new LinkTls(w.app.ctx, w.opts);
    await tls.serveOn({ use: async (host, cert) => void fresh.push([host, cert]) });
    expect(fresh.map(([host, cert]) => [host, cert?.certPem])).toEqual([[HOST, row.certPem]]);
    expect(fresh[0]![1]?.keyPem === decryptSecret(row.certKeyEnc!, w.config.secret)).toBe(true);

    w.set.failing = new AcmeError('unreachable');
    await w.app.ctx.links.set(w.companyId, 'globex');
    await tls.tick();
    expect(fresh.at(-1)).toEqual([GLOBEX, null]);

    await w.app.ctx.links.remove(w.companyId);
    await tls.tick();
    expect(fresh.at(-1)).toEqual([null, null]);
    expect(await w.row()).toMatchObject({ name: null, certPem: null, certDirectory: null, certKeyEnc: null, notAfter: null, renewAt: null, askAt: null, mode: 'http', directory: DIRECTORY, accountUrl: row.accountUrl, accountKeyEnc: row.accountKeyEnc });
  });

  it('is given a certificate only when it changes', async () => {
    const w = await stage();
    await w.tls.tick();
    const uses = w.seen.used.length;
    await w.tls.tick();
    expect(w.seen.used).toHaveLength(uses);
    w.move(60 * DAY);
    await w.tls.tick();
    expect(w.seen.used).toHaveLength(uses + 1);
    expect(w.seen.used.at(-1)?.[1]?.certPem).toBe((await w.row()).certPem);
  });

  it('gets a stand-in with certificates off, whatever the row holds', async () => {
    const w = await stage();
    await w.tls.tick();
    const off = new LinkTls({ ...w.app.ctx, config: { ...w.app.ctx.config, acmeDirectory: null } }, w.opts);
    const given: Used[] = [];
    await off.serveOn({ use: async (host, cert) => void given.push([host, cert]) });
    expect(given).toEqual([[HOST, null]]);
  });

  it('counts as not holding a key it cannot read', async () => {
    const w = await stage();
    await w.tls.tick();
    const warn = vi.spyOn(w.app.ctx.log, 'warn');
    await updateTls(w.db, w.companyId, { certKeyEnc: encryptSecret('text', Buffer.alloc(32, 9)) });
    await (await w.serving()).tick();
    expect(warn).toHaveBeenCalled();
    expect((await w.row()).mode).toBe('http');
    expect(w.tunnelMode()).toBe('http');
  });
});

describe('running on its own', () => {
  const KEEPER_FRESH = () => new Date().toISOString();
  /* Long enough for a pass nobody should have started to show. */
  const aMoment = () => new Promise(resolve => setTimeout(resolve, 50));

  it('ticks now and every minute until it is stopped', async () => {
    const w = await stage();
    await w.tls.tick();
    const tls = await w.serving();
    w.seen.issues.length = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => {
      tls.stop();
      vi.useRealTimers();
    });
    w.move(60 * DAY);
    tls.start();
    await until(() => w.seen.issues.length === 1, PASS_MS);
    await tls.tick();

    w.move(60 * DAY);
    vi.advanceTimersByTime(59_999);
    await aMoment();
    expect(w.seen.issues).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await until(() => w.seen.issues.length === 2, PASS_MS);
    await tls.tick();

    tls.stop();
    w.move(60 * DAY);
    vi.advanceTimersByTime(60_000);
    await aMoment();
    expect(w.seen.issues).toHaveLength(2);
  });

  it('kicks only while it runs, and every change of the link kicks it', async () => {
    const w = await stage();
    const tls = await w.serving();
    w.app.ctx.tls = tls;
    tls.kick();
    await aMoment();
    expect(w.seen.issues).toEqual([]);

    tls.start();
    onTestFinished(() => tls.stop());
    await until(() => w.seen.issues.length === 1, PASS_MS);
    await tls.tick();
    await w.app.ctx.links.set(w.companyId, 'globex');
    await until(() => w.seen.issues.length === 2, PASS_MS);
    expect(w.seen.issues[1]!.host).toBe(GLOBEX);
    await tls.tick();
    await w.app.ctx.links.remove(w.companyId);
    await until(async () => (await w.row()).certPem === null, PASS_MS);

    tls.stop();
    await w.app.ctx.links.set(w.companyId, 'initech');
    await aMoment();
    expect(w.seen.issues).toHaveLength(2);
  });

  it('gets its word from a new link in setup', async () => {
    const relay = await fakeRelay();
    const control = mkdtempSync(join(tmpdir(), 'hh-link-tls-'));
    onTestFinished(() => rmSync(control, { recursive: true, force: true }));
    const { app } = await testApp({ ACME_DIRECTORY: DIRECTORY, RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: control });
    await app.ready();
    const clock = { now: Date.now() };
    const { seen, acme, renewalInfo, probe, listener } = fakes(clock, () => app.ctx.challenges);
    const tls = new LinkTls(app.ctx, { acme, renewalInfo, probe, now: () => clock.now, random: () => 0.5 });
    await tls.serveOn(listener);
    app.ctx.tls = tls;
    tls.start();
    onTestFinished(() => tls.stop());
    await tls.tick();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, link: { name: 'acme' } } });
    expect(res.statusCode).toBe(201);
    await until(() => seen.issues.length === 1, PASS_MS);
    expect(seen.issues).toEqual([{ host: HOST, replaces: undefined }]);
  });

  it('orders only while the app leads', async () => {
    const w = await stage();
    const dir = mkdtempSync(join(tmpdir(), 'hh-link-tls-mode-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const say = (mode: 'lead' | 'read') => writeKeeperState(dir, { mode, at: KEEPER_FRESH(), link: null });
    const mode = new AppMode({ dir, fromKeeper: true, log: () => {} });
    const tls = await w.serving();
    mode.whenLead(() => tls.start(), () => tls.stop());
    onTestFinished(() => tls.stop());

    say('read');
    await mode.check();
    tls.kick();
    await aMoment();
    expect(w.seen.issues).toEqual([]);

    say('lead');
    await mode.check();
    await tls.tick();
    expect(w.seen.issues).toHaveLength(1);

    say('read');
    await mode.check();
    w.move(60 * DAY);
    tls.kick();
    await tls.tick();
    expect(w.seen.issues).toHaveLength(1);
  });

  const PASSING = { up: true, relayStarted: 1, passthrough: true };

  it('moves no mode once it is stopped during a pass, at the first word of the relay or the second', async () => {
    for (const stopAt of [1, 2]) {
      const w = await stage();
      const tls = await w.serving();
      let asked = 0;
      vi.spyOn(w.app.ctx.links.relay, 'health').mockImplementation(async () => {
        if (++asked === stopAt) tls.stop();
        return PASSING;
      });
      await tls.tick();
      expect(asked, `stopped at ${stopAt}`).toBe(stopAt);
      expect((await w.row()).mode).toBe('http');
      expect(w.seen.probes).toEqual([]);
      expect(w.tunnelMode()).toBe('http');
    }
  });

  it('leaves the way back to the next leader when it is stopped during the probe', async () => {
    const w = await stage();
    const tls = await w.serving();
    w.set.probeAnswer = false;
    w.set.onProbe = () => tls.stop();
    await tls.tick();
    expect(await w.row()).toMatchObject({ mode: 'https', httpsBlockedUntil: null });
    expect(w.tunnelMode()).toBe('https');
  });

  it('takes a row gone under a pass as one line, and the next pass makes it again', async () => {
    const w = await stage();
    const warn = vi.spyOn(w.app.ctx.log, 'warn');
    w.set.onIssue = () => w.db.delete(linkTls).where(eq(linkTls.companyId, w.companyId));
    await w.tls.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls).includes('The link has no certificate row to change.')).toBe(true);
    expect(await tlsOf(w.db, w.companyId)).toBeNull();

    w.set.onIssue = async () => undefined;
    await w.tls.tick();
    const row = await w.row();
    expect(certInfo(row.certPem!).names).toEqual([HOST]);
    expect(row.mode).toBe('https');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('takes a pass that fails as one line, and the next starts over', async () => {
    const w = await stage();
    const warn = vi.spyOn(w.app.ctx.log, 'warn');
    vi.spyOn(w.app.ctx.links.relay, 'health').mockRejectedValueOnce(new Error('out of the blue'));
    await w.tls.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await w.row()).mode).toBe('http');
    await w.tls.tick();
    expect((await w.row()).mode).toBe('https');
  });
});

describe('GET /api/link', () => {
  const secrets = /PRIVATE KEY|certKeyEnc|accountKeyEnc|keyPem|certPem/;

  it("tells the link's encryption", async () => {
    const w = await stage();
    const tlsOfAnswer = async () => (await w.app.inject({ url: '/api/link', ...as(w.ceo) })).json().tls as unknown;
    expect(await tlsOfAnswer()).toEqual({ mode: 'http', certificate: false, expiresAt: null, failedAt: null });

    await w.tls.tick();
    const res = await w.app.inject({ url: '/api/link', ...as(w.ceo) });
    expect(res.json().tls).toEqual({ mode: 'https', certificate: true, expiresAt: new Date(w.start + 90 * DAY).toISOString(), failedAt: null });
    expect(secrets.test(res.body)).toBe(false);

    w.set.failing = new AcmeError('invalid');
    await w.app.ctx.links.set(w.companyId, 'globex');
    await w.tls.tick();
    expect(await tlsOfAnswer()).toEqual({ mode: 'http', certificate: false, expiresAt: null, failedAt: new Date(w.start).toISOString() });

    await w.app.ctx.links.remove(w.companyId);
    expect(await tlsOfAnswer()).toBeNull();
  });
});
