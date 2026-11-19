import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Crl } from '@peculiar/x509';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as appCall from '../src/modules/keeper/app-call.js';
import { MachineIdentity } from '../src/modules/keeper/identity.js';
import { machineKey } from '../src/modules/keeper/machine-keys.js';
import { CRL_FILE, PeerLink } from '../src/modules/keeper/peer-link.js';
import { TunnelKeeper } from '../src/modules/link/tunnel.js';
import { issueCertificate, makeAuthority, makeCrl } from '../src/modules/network/authority.js';
import { PeerDoor } from '../src/net/peer-door.js';
import { PeerServer, refusalOf } from '../src/net/peer-server.js';

const DAY = 86_400_000;
const POLL = 5000;
const START = Date.UTC(2025, 0, 1);
const MACHINE = '11111111-1111-4111-8111-111111111111';
const REVOKED = '12345678123456781234567812345678';
const local = { host: '127.0.0.1', port: 1 };

async function peers(initial: string[] = [], keptAt?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-peer-crl-'));
  const authority = await makeAuthority(MACHINE, new Date(START));
  const key = machineKey(dir);
  const cert = await issueCertificate(authority, { machineId: MACHINE, role: 'data', signKey: key.publicPem });
  const identity = new MachineIdentity({ dir, app: local, commit: '', published: { web: null, peer: null }, leading: () => true, log: () => {} });
  vi.spyOn(identity, 'machineKey').mockReturnValue(key);
  vi.spyOn(identity, 'certificate').mockReturnValue({ machine: MACHINE, role: 'data', certPem: cert.certPem,
    authorityPem: authority.certPem, until: cert.until.toISOString() });
  vi.spyOn(PeerDoor.prototype, 'start').mockResolvedValue();
  vi.spyOn(TunnelKeeper.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(PeerServer.prototype, 'listen').mockImplementation(port => Promise.resolve(port));
  let offered: string | null = null;
  vi.spyOn(PeerServer.prototype, 'refresh').mockImplementation(function (this: PeerServer) {
    offered = this['opts'].crl();
  });
  let revoked = initial;
  let sign = true;
  let signer = authority;
  vi.spyOn(appCall, 'askApp').mockImplementation(async () => {
    const crlPem = sign ? await makeCrl(signer, revoked) : null;
    return { status: 200, ok: true, json: () => ({ machine: MACHINE, authorityPem: authority.certPem, revoked, crlPem, link: null }) };
  });
  if (keptAt !== undefined) {
    const crlPem = await makeCrl(authority, initial, new Date(keptAt));
    writeFileSync(join(dir, CRL_FILE), JSON.stringify({ serials: initial, crlPem }));
  }
  const link = new PeerLink({ dir, app: local, db: null, machineId: MACHINE, commit: '', identity, mode: () => 'lead',
    settings: async () => null, ports: { peer: 1, peerApp: 2 }, everyMs: POLL, log: () => {},
  });
  onTestFinished(async () => {
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async () => {
    await link.start();
    await link['reading'];
  };
  const poll = async (day: number) => {
    vi.setSystemTime(START + day * DAY - POLL);
    await vi.advanceTimersByTimeAsync(POLL);
    await link['reading'];
  };
  const saved = () => readFileSync(join(dir, CRL_FILE), 'utf8');
  return {
    link, start, poll, saved, offered: () => offered,
    unsigned: (serials: string[]) => { sign = false; revoked = serials; },
    signedElsewhere: async () => { signer = await makeAuthority(MACHINE, new Date(START)); },
  };
}

/* The TLS input must have a nextUpdate strictly after the time of a new handshake. */
function allowsHandshakeAt(pem: string | null, now: Date): boolean {
  if (!pem) return false;
  const { thisUpdate, nextUpdate } = new X509Crl(pem);
  return thisUpdate <= now && !!nextUpdate && nextUpdate > now;
}

describe('renewal of the CRL held by the peer link', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([365, 366])('keeps serving a valid CRL at day %s without any revocation change', async day => {
    const f = await peers();
    await f.start();
    const old = f.offered();
    expect(allowsHandshakeAt(old, new Date())).toBe(true);
    await f.poll(day);
    expect(allowsHandshakeAt(f.offered(), new Date()), 'the TLS context would reject a new handshake with this CRL').toBe(true);
    expect(f.offered()).not.toBe(old);
  });

  it('renews on its poll well before expiry and keeps the revoked serials', async () => {
    const f = await peers([REVOKED]);
    await f.start();
    const old = f.saved();
    await f.poll(30);
    expect(f.saved()).toBe(old);
    await f.poll(345);
    expect(f.saved()).not.toBe(old);
    const list = new X509Crl(f.offered()!);
    expect(list.entries.map(entry => entry.serialNumber.toLowerCase())).toEqual([REVOKED]);
    expect(list.nextUpdate?.getTime()).toBeGreaterThan(START + 365 * DAY);
  });

  it.each([345, 366])('replaces a %s-day-old list on the startup read', async age => {
    const f = await peers([REVOKED], START - age * DAY);
    const old = f.saved();
    await f.start();
    expect(allowsHandshakeAt(f.offered(), new Date())).toBe(true);
    expect(f.saved()).not.toBe(old);
  });

  it('keeps the current list when a renewal is signed with a different key', async () => {
    const f = await peers([REVOKED]);
    await f.start();
    const held = f.saved();
    await f.signedElsewhere();
    await f.poll(345);
    expect(f.saved()).toBe(held);
    expect(f.link.revoked().has(REVOKED)).toBe(true);
  });

  it('keeps new revocations reported while the issuer cannot sign a replacement', async () => {
    const f = await peers();
    await f.start();
    const held = f.saved();
    f.unsigned([REVOKED]);
    await f.poll(365);
    expect(f.link.revoked().has(REVOKED)).toBe(true);
    f.unsigned([]);
    await f.poll(366);
    expect(f.saved()).toBe(held);
    expect(f.link.revoked().has(REVOKED)).toBe(true);
  });

  it('still refuses a known revoked serial when the issuer cannot replace an expired list', async () => {
    const f = await peers([REVOKED]);
    await f.start();
    f.unsigned([]);
    await f.poll(366);
    const now = new Date();
    expect(allowsHandshakeAt(f.offered(), now)).toBe(false);
    const peer = { machine: MACHINE, role: 'worker' as const, serial: REVOKED, until: new Date(now.getTime() + DAY), address: local.host };
    expect(refusalOf(peer, f.link.revoked(), now)).toBe('CERT_REVOKED');
  });
});
