import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { clientFor, linkClientId } from '../src/modules/link/client.js';
import { peerClientFor, peerClientId, peerConfigFor, serviceName, type PeerServices } from '../src/modules/link/peer-client.js';

const MACHINE_ID = `ab12cd34${'0'.repeat(24)}`;
const DATA_SECRET = 'd'.repeat(43);
const APP_SECRET = 'a'.repeat(43);
const SERVICES: PeerServices = {
  settings: { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), mode: 'http', tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' } },
  secrets: { data: DATA_SECRET, app: APP_SECRET },
};
const LOCAL = { data: 7070, app: 7071 };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-peer-client-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the frpc that offers a machine to its peers", () => {
  it('names itself and its two services after the link and the machine', () => {
    expect(peerClientId('acme', MACHINE_ID)).toBe('acme-ab12cd34-peer');
    expect(serviceName('acme', MACHINE_ID, 'data')).toBe('acme-ab12cd34-data');
    expect(serviceName('acme', MACHINE_ID, 'app')).toBe('acme-ab12cd34-app');
  });

  it('offers the peer link and the app as two secret services, each at its own door of this keeper', () => {
    expect(peerConfigFor(SERVICES, { machineId: MACHINE_ID, local: LOCAL })).toBe(`serverAddr = "relay.hornhoof.test"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
clientID = "acme-ab12cd34-peer"
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = -1
transport.tcpMuxKeepaliveInterval = 10
metadatas.name = "acme"
metadatas.key = "${'k'.repeat(32)}"
metadatas.client = "acme-ab12cd34-peer"

[[proxies]]
name = "acme-ab12cd34-data"
type = "stcp"
secretKey = "${DATA_SECRET}"
localIP = "127.0.0.1"
localPort = 7070

[[proxies]]
name = "acme-ab12cd34-app"
type = "stcp"
secretKey = "${APP_SECRET}"
localIP = "127.0.0.1"
localPort = 7071
`);
  });

  it('refuses a link whose name or relay is not what a link has', () => {
    const named = (name: string) => ({ ...SERVICES, settings: { ...SERVICES.settings, name } });
    expect(() => peerConfigFor(named('Acme"\nx'), { machineId: MACHINE_ID, local: LOCAL })).toThrow();
    const relay = { ...SERVICES, settings: { ...SERVICES.settings, tunnel: { serverAddr: 'relay"\nx', serverPort: 443, protocol: 'wss' } } };
    expect(() => peerConfigFor(relay, { machineId: MACHINE_ID, local: LOCAL })).toThrow();
  });

  it('keeps a file of its own, for its owner only, beside the link\'s', () => {
    const dir = folder();
    const link = () => clientFor(SERVICES.settings, { dir, clientId: linkClientId('acme', MACHINE_ID), local: { http: { ip: '127.0.0.1', port: 7081 }, https: { ip: '127.0.0.1', port: 7443 } } });
    const peer = () => peerClientFor(SERVICES, { dir, machineId: MACHINE_ID, local: LOCAL });
    expect(link()).toEqual({ program: 'frpc', args: ['-c', join(dir, 'frpc.toml')] });
    expect(peer()).toEqual({ program: 'frpc', args: ['-c', join(dir, 'frpc-peer.toml')] });
    expect(statSync(join(dir, 'frpc-peer.toml')).mode & 0o777).toBe(0o600);
    const [ofLink, ofPeer] = [readFileSync(join(dir, 'frpc.toml'), 'utf8'), readFileSync(join(dir, 'frpc-peer.toml'), 'utf8')];
    expect(ofLink).toContain('clientID = "acme-ab12cd34-link"');
    expect(ofPeer).toContain('clientID = "acme-ab12cd34-peer"');
    link();
    peer();
    expect(readFileSync(join(dir, 'frpc.toml'), 'utf8')).toBe(ofLink);
    expect(readFileSync(join(dir, 'frpc-peer.toml'), 'utf8')).toBe(ofPeer);
  });
});
