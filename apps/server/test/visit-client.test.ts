import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { visitClientFor, visitClientId, visitConfigFor, VISIT_FIRST_PORT, type VisitSettings } from '../src/modules/link/visit-client.js';

const MACHINE_ID = `ab12cd34${'0'.repeat(56)}`;
const SERVER_ID = `77aa0011${'1'.repeat(56)}`;
const COPY_ID = `99bb2233${'2'.repeat(56)}`;
const VISITOR_KEY = 'v'.repeat(32);
const APP_SECRET = 'a'.repeat(43);
const LINK: VisitSettings = { name: 'acme', serverAddr: 'relay.hornhoof.test', serverPort: 443, visitorKey: VISITOR_KEY, appSecret: APP_SECRET };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-visit-client-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the frpc a worker reaches the company's data machines with", () => {
  it('logs in as a visitor of the link and opens the app of the machine it is told', () => {
    expect(visitClientId('acme', MACHINE_ID)).toBe('acme-ab12cd34-visit');
    expect(VISIT_FIRST_PORT).toBe(7090);
    expect(visitConfigFor(LINK, { machineId: MACHINE_ID, targets: [SERVER_ID] })).toBe(`serverAddr = "relay.hornhoof.test"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
clientID = "acme-ab12cd34-visit"
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = -1
transport.tcpMuxKeepaliveInterval = 10
metadatas.name = "acme"
metadatas.visitor = "${VISITOR_KEY}"
metadatas.client = "acme-ab12cd34-visit"

[[visitors]]
name = "acme-ab12cd34-to-77aa0011"
type = "stcp"
serverName = "acme-77aa0011-app"
secretKey = "${APP_SECRET}"
bindAddr = "127.0.0.1"
bindPort = 7090
`);
  });

  it('gives each data machine a local port of its own, in their order', () => {
    const config = visitConfigFor(LINK, { machineId: MACHINE_ID, targets: [SERVER_ID, COPY_ID] });
    expect(config.match(/^serverName = .*$/gm)).toEqual(['serverName = "acme-77aa0011-app"', 'serverName = "acme-99bb2233-app"']);
    expect(config.match(/^bindPort = .*$/gm)).toEqual(['bindPort = 7090', 'bindPort = 7091']);
    expect(config.match(/^bindAddr = .*$/gm)).toEqual(['bindAddr = "127.0.0.1"', 'bindAddr = "127.0.0.1"']);
  });

  /* A visitor registers nothing, so it needs no link key, and a worker holds none. */
  it('carries no link key and offers nothing', () => {
    const config = visitConfigFor(LINK, { machineId: MACHINE_ID, targets: [SERVER_ID] });
    expect(config).not.toContain('metadatas.key');
    expect(config).not.toContain('[[proxies]]');
  });

  it('refuses what is not a link, a relay or a machine id', () => {
    const made = (over: Partial<VisitSettings>, targets = [SERVER_ID]) => () => visitConfigFor({ ...LINK, ...over }, { machineId: MACHINE_ID, targets });
    expect(made({ name: 'Acme"\nx = 1' })).toThrow('is not a link name');
    expect(made({ serverAddr: 'relay"\nx = "1' })).toThrow();
    expect(made({ serverPort: 0 })).toThrow();
    expect(made({ visitorKey: '' })).toThrow('no visitor key');
    expect(made({}, ['not hex'])).toThrow('is not a machine id');
  });

  it('writes its config for its user alone, beside the others', () => {
    const dir = folder();
    const client = visitClientFor(LINK, { machineId: MACHINE_ID, targets: [SERVER_ID], dir });
    const path = join(dir, 'frpc-visit.toml');
    expect(client).toEqual({ program: 'frpc', args: ['-c', path] });
    expect(readFileSync(path, 'utf8')).toBe(visitConfigFor(LINK, { machineId: MACHINE_ID, targets: [SERVER_ID] }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
