import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { MachineRole } from '../src/db/schema.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import { DataLinks, type DataLinksOptions, type DataPeers } from '../src/modules/keeper/data-links.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import type { VisitSettings } from '../src/modules/link/visit-client.js';
import { issueCertificate, makeAuthority, makeCrl, type Authority } from '../src/modules/network/authority.js';
import { PeerDoor } from '../src/net/peer-door.js';
import { PeerServer } from '../src/net/peer-server.js';
import { until } from './helpers.js';

const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const LEADER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const COPY_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const LEADER_NETWORK_ID = `77aa0011${'1'.repeat(56)}`;
const COPY_NETWORK_ID = `99bb2233${'2'.repeat(56)}`;
const LOOPBACK = '127.0.0.1';

type Machine = { id: string; role: MachineRole; key: MachineKey; held: HeldCertificate };

async function machineOf(authority: Authority, id: string, role: MachineRole): Promise<Machine> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const issued = await issueCertificate(authority, { machineId: id, role, signKey: publicKey });
  return { id, role, key: { privatePem: privateKey, publicPem: publicKey }, held: { machine: id, role, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() } };
}

/* A copy's database, for these tests: it sends back what it gets, with its own word first. */
async function tcpEcho(word: string): Promise<{ host: string; port: number }> {
  const server = net.createServer(socket => {
    socket.on('error', () => undefined);
    socket.on('data', chunk => socket.write(word + String(chunk)));
  });
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  onTestFinished(() => void server.close());
  return { host: LOOPBACK, port: (server.address() as AddressInfo).port };
}

/* What a door answers one line with, or 'closed' when it takes no connection or ends it. */
function through(port: number, text: string): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect({ host: LOOPBACK, port });
    socket.on('error', () => resolve('closed'));
    socket.once('close', () => resolve('closed'));
    socket.once('data', chunk => {
      resolve(String(chunk));
      socket.destroy();
    });
    socket.write(text);
  });
}

/* The leader's side toward one copy, whose peer link is served as its keeper serves it. */
async function standUp(over: Partial<DataLinksOptions> = {}) {
  const authority = await makeAuthority(COMPANY);
  const leader = await machineOf(authority, LEADER_ID, 'data');
  const copy = await machineOf(authority, COPY_ID, 'data');
  const crl = await makeCrl(authority, []);
  const door = new PeerDoor({ app: await tcpEcho('app: ') });
  await door.start();
  onTestFinished(() => door.stop());
  const copyPeers = new PeerServer({
    held: () => copy.held, key: copy.key, crl: () => crl, revoked: () => new Set<string>(), door, db: await tcpEcho('copy: '),
    hello: () => ({ machine: copy.id, role: 'data', lead: false, commit: 'c0ffee' }), log: () => undefined,
  });
  onTestFinished(() => copyPeers.close());
  const peerPort = await copyPeers.listen(0, 'peer', LOOPBACK);
  const dir = mkdtempSync(join(tmpdir(), 'hh-data-links-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const state = {
    peers: {
      machine: LEADER_ID,
      data: [
        { machine: LEADER_ID, networkId: LEADER_NETWORK_ID, addresses: [LOOPBACK], peerPort: 1 },
        { machine: COPY_ID, networkId: COPY_NETWORK_ID, addresses: [LOOPBACK], peerPort },
      ],
      doors: [] as string[],
      link: null,
    } as DataPeers | null,
    leads: true,
  };
  const lines: string[] = [];
  const links = new DataLinks({
    machineId: LEADER_NETWORK_ID, dir, held: () => leader.held, key: () => leader.key, peers: () => state.peers, revoked: () => new Set<string>(), own: () => [],
    settings: async () => null, leads: () => state.leads, replica: null, log: line => lines.push(line),
    doorHost: LOOPBACK, allowed: async () => [LOOPBACK], everyMs: 20, sessions: { everyMs: 20, helloMs: 20, connectMs: 2000 }, ...over,
  });
  onTestFinished(() => links.stop());
  return { links, state, lines, leader, copy, dir };
}

describe("the leading keeper's links to the machines that hold copies", () => {
  it('opens a door to a copy its app names', async () => {
    const stand = await standUp();
    stand.links.start();
    expect(stand.links.doors()).toEqual({});
    stand.state.peers!.doors = [COPY_NETWORK_ID];
    await until(() => COPY_NETWORK_ID in stand.links.doors());
    const port = stand.links.doors()[COPY_NETWORK_ID]!;
    await until(async () => (await through(port, 'ping')) === 'copy: ping');
    /* It dialed the copy and never itself. */
    expect(stand.links.seen()).toEqual([LOOPBACK]);
    /* Named no more, the door goes. */
    stand.state.peers!.doors = [];
    await until(() => Object.keys(stand.links.doors()).length === 0);
    expect(await through(port, 'ping')).toBe('closed');
  });

  it('opens no door to a machine that keeps no data, and takes nobody it is not told to', async () => {
    const stand = await standUp({ allowed: async () => ['192.0.2.1'] });
    stand.links.start();
    stand.state.peers!.doors = [COPY_NETWORK_ID, 'f'.repeat(64)];
    await until(() => Object.keys(stand.links.doors()).length === 2);
    expect(await through(stand.links.doors()[COPY_NETWORK_ID]!, 'ping')).toBe('closed');
    const allowed = await standUp();
    allowed.links.start();
    allowed.state.peers!.doors = ['f'.repeat(64)];
    await until(() => Object.keys(allowed.links.doors()).length === 1);
    expect(await through(allowed.links.doors()['f'.repeat(64)]!, 'ping')).toBe('closed');
    await until(() => allowed.lines.some(line => line.includes('the machine is not among those that keep data')));
  });

  it('reaches the copies through the relay while the company has a link', async () => {
    const visits: { link: VisitSettings; machineId: string; targets: string[] }[] = [];
    const tunnel = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
    const stand = await standUp({
      settings: async () => ({ url: 'https://acme.hornhoof.test', name: 'acme', key: 'k'.repeat(32), tunnel, mode: 'http' }) as never,
      visitClientFor: (link, machineId, targets) => (visits.push({ link, machineId, targets }), { program: 'true', args: [] }),
    });
    stand.links.start();
    /* No link, no visitor. */
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(visits).toEqual([]);
    stand.state.peers!.link = { name: 'acme', dataSecret: 'd'.repeat(43), visitorKey: 'v'.repeat(32) };
    await until(() => visits.length > 0);
    expect(visits[0]).toMatchObject({ machineId: LEADER_NETWORK_ID, targets: [COPY_NETWORK_ID] });
    expect(visits[0]!.link).toEqual({ name: 'acme', serverAddr: 'relay.hornhoof.test', serverPort: 443, visitorKey: 'v'.repeat(32), appSecret: '', dataSecret: 'd'.repeat(43) });
  });

  it('keeps the role and the publication while it leads', async () => {
    const run: string[] = [];
    let ready = true;
    const sql = (): Sql & { close(): Promise<void> } => ({
      query: async <R>(text: string) => {
        const kind = text.startsWith('DO $replica$') ? 'role' : text.includes('has_schema_privilege') ? 'ready?' : text.includes('FROM pg_publication') ? 'published?' : text.startsWith('CREATE PUBLICATION') ? 'publish' : text;
        run.push(kind);
        return { rows: (kind === 'ready?' ? [{ ready }] : []) as R[] };
      },
      close: async () => undefined,
    });
    const stand = await standUp({ replica: { connect: sql, password: 'the-password' }, replicaEveryMs: 60 });
    stand.state.leads = false;
    stand.links.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(run).toEqual([]);
    /* At its first lead: the role and the publication, whatever is there. */
    stand.state.leads = true;
    await until(() => run.includes('publish'));
    expect(run.slice(0, 3)).toEqual(['role', 'published?', 'publish']);
    /* Then a look each time: the role is made again only when it is gone or lost its rights. */
    await until(() => run.filter(kind => kind === 'ready?').length >= 2);
    expect(run.filter(kind => kind === 'role')).toHaveLength(1);
    ready = false;
    await until(() => run.filter(kind => kind === 'role').length >= 2);
    for (const text of run) expect(text).not.toContain('the-password');
  });
});
