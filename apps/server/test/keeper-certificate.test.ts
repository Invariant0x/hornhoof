import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CERT_FILE, CertificateKeeper, readHeldCertificate } from '../src/modules/keeper/certificate.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import { machineKey } from '../src/modules/keeper/machine-keys.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { certFacts, issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import type { MachineRole } from '../src/db/schema.js';
import type { Authority } from '../src/modules/network/authority.js';
import { until } from './helpers-basic.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ISSUED_AT = new Date('2026-06-15T12:00:00.000Z');
const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const MACHINE = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_MACHINE = 'bbbbbbbb-0000-4000-8000-00000000000b';

let authority: Authority;
let otherAuthority: Authority;
const folders: string[] = [];
const keepers: CertificateKeeper[] = [];

beforeAll(async () => {
  authority = await makeAuthority(COMPANY, ISSUED_AT);
  otherAuthority = await makeAuthority(COMPANY, ISSUED_AT);
});

/* The keeper's clock is virtual: its looks and retries wait for the test to move it, and what they wait between, the disk
   and the signing of a key, is real and comes in a turn of the event loop. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const keeper of keepers.splice(0)) keeper.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'hh-keeper-certificate-'));
  folders.push(folder);
  return folder;
}

function aKey(): MachineKey {
  return machineKey(tempFolder());
}

async function issued(signKey: string, at: Date = ISSUED_AT, role: MachineRole = 'data'): Promise<HeldCertificate> {
  const cert = await issueCertificate(authority, { machineId: MACHINE, role, signKey, now: at });
  return { machine: MACHINE, role, certPem: cert.certPem, authorityPem: authority.certPem, until: cert.until.toISOString() };
}

// An ask that issues from the test's authority, as the app's route does, and counts its calls.
function issuing(at: Date = ISSUED_AT): { ask: (signKey: string) => Promise<HeldCertificate>; calls: () => number } {
  const ask = vi.fn((signKey: string) => issued(signKey, at));
  return { ask, calls: () => ask.mock.calls.length };
}

type Waited = { resolve: (held: HeldCertificate) => void; reject: (err: Error) => void };

// An ask whose answers the test gives by hand, so what holds between the question and the answer can be looked at.
function answeredByHand(): { ask: (signKey: string) => Promise<HeldCertificate>; asked: Waited[] } {
  const asked: Waited[] = [];
  const ask = (): Promise<HeldCertificate> => new Promise((resolve, reject) => asked.push({ resolve, reject }));
  return { ask, asked };
}

function keeperOn(
  dir: string,
  key: MachineKey,
  ask: (signKey: string) => Promise<HeldCertificate>,
  more: { now?: () => Date; retryMs?: number; everyMs?: number; lines?: string[] } = {},
): CertificateKeeper {
  const { lines = [], ...timing } = more;
  const keeper = new CertificateKeeper({ dir, key, ask, now: () => ISSUED_AT, log: (line) => lines.push(line), ...timing });
  keepers.push(keeper);
  return keeper;
}

function announced(keeper: CertificateKeeper): Promise<HeldCertificate> {
  return new Promise((resolve) => keeper.onChange(resolve));
}

/* What is under way ends, then the keeper's clock moves on by ms. */
async function after(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(ms);
}

function writeHeld(dir: string, held: unknown): void {
  writeFileSync(join(dir, CERT_FILE), JSON.stringify(held));
}

const sameCertificate = (a: HeldCertificate | null, b: HeldCertificate | null): boolean => a?.certPem === b?.certPem;

describe('CertificateKeeper', () => {
  it('asks for a certificate when it holds none, and keeps it', async () => {
    const dir = tempFolder();
    const key = aKey();
    const { ask, calls } = issuing();
    const keeper = keeperOn(dir, key, ask);
    const heard = vi.fn();
    keeper.onChange(heard);
    const first = announced(keeper);
    expect(keeper.current()).toBeNull();
    keeper.start();
    const held = await first;

    expect(calls()).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(statSync(join(dir, CERT_FILE)).mode & 0o777).toBe(0o600);
    expect(certFacts(held.certPem).signKey === key.publicPem).toBe(true);

    const again = issuing();
    const next = keeperOn(dir, key, again.ask);
    next.start();
    await after(10);
    expect(again.calls()).toBe(0);
    expect(sameCertificate(next.current(), held)).toBe(true);
  });

  it('writes the certificate before it announces it', async () => {
    const dir = tempFolder();
    const key = aKey();
    const keeper = keeperOn(dir, key, issuing().ask);
    const onDisk = new Promise<HeldCertificate | null>((resolve) => keeper.onChange(() => resolve(readHeldCertificate(dir, key))));
    keeper.start();
    expect(await onDisk).not.toBeNull();
  });

  it('renews a certificate older than 7 days', async () => {
    const dir = tempFolder();
    const key = aKey();
    writeHeld(dir, await issued(key.publicPem));
    const later = new Date(ISSUED_AT.getTime() + 7 * DAY_MS + HOUR_MS);
    // The answer is as old as the one it replaces: a machine whose clock runs ahead must not ask without a pause.
    const { ask, calls } = issuing();
    const keeper = keeperOn(dir, key, ask, { now: () => later });
    const renewed = announced(keeper);
    keeper.start();
    await renewed;
    await after(20);
    expect(calls()).toBe(1);
  });

  it('asks nothing while its certificate is younger than 7 days', async () => {
    const dir = tempFolder();
    const key = aKey();
    writeHeld(dir, await issued(key.publicPem));
    const { ask, calls } = issuing();
    keeperOn(dir, key, ask, { now: () => new Date(ISSUED_AT.getTime() + 7 * DAY_MS - HOUR_MS) }).start();
    await after(10);
    expect(calls()).toBe(0);
  });

  it('looks again at a certificate it holds and renews it once it has grown old', async () => {
    const dir = tempFolder();
    const key = aKey();
    writeHeld(dir, await issued(key.publicPem));
    let today = ISSUED_AT;
    const { ask, calls } = issuing();
    keeperOn(dir, key, ask, { now: () => today, everyMs: 5 }).start();
    await after(20);
    expect(calls()).toBe(0);
    today = new Date(ISSUED_AT.getTime() + 8 * DAY_MS);
    await after(5);
    expect(calls()).toBe(1);
  });

  it('tries again after a failed ask, and says so once', async () => {
    const dir = tempFolder();
    const key = aKey();
    const lines: string[] = [];
    const ask = vi
      .fn((signKey: string) => issued(signKey))
      .mockRejectedValueOnce(new Error('the app is starting'))
      .mockRejectedValueOnce(new Error('the app is starting'));
    const keeper = keeperOn(dir, key, ask, { retryMs: 50, lines });
    const heard = vi.fn();
    keeper.onChange(heard);
    const got = announced(keeper);
    keeper.start();
    await after(49);
    expect(ask).toHaveBeenCalledTimes(1);
    await after(1);
    await after(50);
    await got;
    expect(ask).toHaveBeenCalledTimes(3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["Could not get this machine's certificate: the app is starting"]);
  });

  it('says a failure again once an answer has come between', async () => {
    const dir = tempFolder();
    const key = aKey();
    const lines: string[] = [];
    const { ask, asked } = answeredByHand();
    const keeper = keeperOn(dir, key, ask, { retryMs: 1, lines });
    keeper.start();
    asked[0]!.reject(new Error('no answer'));
    await after(1);
    expect(asked.length).toBe(2);
    const got = announced(keeper);
    asked[1]!.resolve(await issued(key.publicPem));
    await got;
    keeper.renewNow();
    asked[2]!.reject(new Error('no answer'));
    await until(() => lines.length === 2);
  });

  it('does not take a certificate for another key', async () => {
    const dir = tempFolder();
    const key = aKey();
    writeHeld(dir, await issued(aKey().publicPem));
    const { ask, calls } = issuing();
    const keeper = keeperOn(dir, key, ask);
    expect(keeper.current()).toBeNull();
    const got = announced(keeper);
    keeper.start();
    const held = await got;
    expect(calls()).toBe(1);
    expect(certFacts(held.certPem).signKey === key.publicPem).toBe(true);
  });

  it('takes no answer that is not for its key, and asks again', async () => {
    const dir = tempFolder();
    const key = aKey();
    const someoneElse = await issued(aKey().publicPem);
    const lines: string[] = [];
    const ask = vi.fn((signKey: string) => issued(signKey)).mockResolvedValueOnce(someoneElse);
    const keeper = keeperOn(dir, key, ask, { retryMs: 5, lines });
    const heard: HeldCertificate[] = [];
    keeper.onChange((held) => heard.push(held));
    const got = announced(keeper);
    keeper.start();
    await after(5);
    const held = await got;
    expect(ask).toHaveBeenCalledTimes(2);
    expect(heard.length).toBe(1);
    expect(sameCertificate(held, someoneElse)).toBe(false);
    expect(lines).toEqual(["Could not get this machine's certificate: The app's answer is not a certificate for this machine's key."]);
  });

  it('asks again when told to', async () => {
    const dir = tempFolder();
    const key = aKey();
    const old = await issued(key.publicPem);
    writeHeld(dir, old);
    const { ask, asked } = answeredByHand();
    const keeper = keeperOn(dir, key, ask, { retryMs: HOUR_MS });
    keeper.start();
    expect(asked.length).toBe(0);

    keeper.renewNow();
    expect(asked.length).toBe(1);
    expect(sameCertificate(keeper.current(), old)).toBe(true);

    asked[0]!.reject(new Error('no answer'));
    await after(5);
    expect(sameCertificate(keeper.current(), old)).toBe(true);

    keeper.renewNow();
    expect(asked.length).toBe(2);
    const fresh = await issued(key.publicPem);
    const got = announced(keeper);
    asked[1]!.resolve(fresh);
    await got;
    expect(sameCertificate(keeper.current(), fresh)).toBe(true);
    expect(sameCertificate(readHeldCertificate(dir, key), fresh)).toBe(true);
  });

  it('goes on asking after a failed ask it was told to make', async () => {
    const dir = tempFolder();
    const key = aKey();
    writeHeld(dir, await issued(key.publicPem));
    const ask = vi.fn((signKey: string) => issued(signKey)).mockRejectedValueOnce(new Error('no answer'));
    const keeper = keeperOn(dir, key, ask, { retryMs: 5 });
    keeper.start();
    const got = announced(keeper);
    keeper.renewNow();
    await after(5);
    await got;
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks again after the answer when told to while an ask is open', async () => {
    const dir = tempFolder();
    const key = aKey();
    const { ask, asked } = answeredByHand();
    const keeper = keeperOn(dir, key, ask);
    keeper.start();
    keeper.renewNow();
    expect(asked.length).toBe(1);
    asked[0]!.resolve(await issued(key.publicPem));
    await after(0);
    expect(asked.length).toBe(2);
  });

  it('takes nothing once it has stopped', async () => {
    const dir = tempFolder();
    const key = aKey();
    const { ask, asked } = answeredByHand();
    const keeper = keeperOn(dir, key, ask);
    const heard = vi.fn();
    keeper.onChange(heard);
    keeper.start();
    keeper.stop();
    asked[0]!.resolve(await issued(key.publicPem));
    await after(5);
    expect(keeper.current()).toBeNull();
    expect(heard).not.toHaveBeenCalled();
    expect(existsSync(join(dir, CERT_FILE))).toBe(false);
    keeper.renewNow();
    expect(asked.length).toBe(1);
  });

  it('serves a new certificate its folder refuses, and does not ask for another', async () => {
    const dir = tempFolder();
    const key = aKey();
    const lines: string[] = [];
    const { ask, asked } = answeredByHand();
    const keeper = keeperOn(dir, key, ask, { retryMs: 5, lines });
    keeper.start();
    rmSync(dir, { recursive: true });
    const got = announced(keeper);
    const answer = await issued(key.publicPem);
    asked[0]!.resolve(answer);
    await got;
    await after(20);
    expect(asked.length).toBe(1);
    expect(sameCertificate(keeper.current(), answer)).toBe(true);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^Could not keep this machine's certificate in its folder: /);
  });

  it('survives a listener that throws', async () => {
    const dir = tempFolder();
    const key = aKey();
    const lines: string[] = [];
    const { ask, calls } = issuing();
    const keeper = keeperOn(dir, key, ask, { lines, retryMs: 5 });
    keeper.onChange(() => {
      throw new Error('the listener broke');
    });
    const got = announced(keeper);
    keeper.start();
    await got;
    await after(20);
    expect(calls()).toBe(1);
    expect(lines).toEqual(['A listener of the certificate failed: the listener broke']);
  });
});

describe('readHeldCertificate', () => {
  it('reads what it was given when all of it fits the key', async () => {
    const dir = tempFolder();
    const key = aKey();
    const held = await issued(key.publicPem);
    writeHeld(dir, held);
    expect(sameCertificate(readHeldCertificate(dir, key), held)).toBe(true);
  });

  it('reads as none when there is no file or the file is not JSON', () => {
    const dir = tempFolder();
    const key = aKey();
    expect(readHeldCertificate(dir, key)).toBeNull();
    writeFileSync(join(dir, CERT_FILE), '{"cut short');
    expect(readHeldCertificate(dir, key)).toBeNull();
  });

  it('reads as none what contradicts itself', async () => {
    const dir = tempFolder();
    const key = aKey();
    const held = await issued(key.publicPem);
    const contradictions: unknown[] = [
      { ...held, certPem: undefined },
      { ...held, role: 'owner' },
      { ...held, certPem: 'not a certificate' },
      { ...held, authorityPem: 'not a certificate' },
      { ...held, machine: OTHER_MACHINE },
      { ...held, role: 'worker' },
      { ...held, authorityPem: otherAuthority.certPem },
    ];
    const read = contradictions.map((file) => {
      writeHeld(dir, file);
      return readHeldCertificate(dir, key);
    });
    expect(read).toEqual(contradictions.map(() => null));
  });

  it('never stores what the answer carries beyond the certificate', async () => {
    const dir = tempFolder();
    const key = aKey();
    const held = await issued(key.publicPem);
    const keeper = keeperOn(dir, key, () => Promise.resolve({ ...held, extra: 'stray' } as HeldCertificate));
    const got = announced(keeper);
    keeper.start();
    await got;
    expect(Object.keys(JSON.parse(readFileSync(join(dir, CERT_FILE), 'utf8'))).sort()).toEqual([
      'authorityPem',
      'certPem',
      'machine',
      'role',
      'until',
    ]);
  });
});
