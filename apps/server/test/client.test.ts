import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientFor, configFor, linkClientId, type FrpcLocal } from '../src/modules/link/client.js';
import type { TunnelSettings } from '../src/modules/link/tunnel.js';

const KEY = 'Zm9vYmFyLWtleS1vZi10aGUtYmluZGluZy0wMTIzNDU2';
const CLIENT_ID = 'acme-ab12cd34-link';
const LOCAL: FrpcLocal = { http: { ip: '127.0.0.1', port: 7081 }, https: { ip: '127.0.0.1', port: 8443 } };
const IDENTITY = { clientId: CLIENT_ID, local: LOCAL };

/* What the app writes for a link, with the tunnel as the relay hands it out, including its own config text. */
const settings = (tunnel: Record<string, unknown> = {}, more: Partial<TunnelSettings> = {}): TunnelSettings => ({
  url: 'https://acme.hornhoof.org',
  name: 'acme',
  key: KEY,
  tunnel: { serverAddr: 'hornhoof.org', serverPort: 443, protocol: 'wss', config: 'localIP = "db"\nlocalPort = 5432\n', ...tunnel },
  mode: 'http',
  ...more,
});

const CONFIG = `serverAddr = "hornhoof.org"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
clientID = "${CLIENT_ID}"
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = -1
transport.tcpMuxKeepaliveInterval = 10
metadatas.name = "acme"
metadatas.key = "${KEY}"
metadatas.client = "${CLIENT_ID}"

[[proxies]]
name = "acme"
type = "http"
subdomain = "acme"
localIP = "127.0.0.1"
localPort = 7081
`;

const ABOVE_THE_PROXY = CONFIG.slice(0, CONFIG.indexOf('[[proxies]]'));

const HTTPS_PROXY = `[[proxies]]
name = "acme"
type = "https"
subdomain = "acme"
localIP = "127.0.0.1"
localPort = 8443
transport.proxyProtocolVersion = "v2"
`;

describe('the tunnel client', () => {
  it("runs frpc with a config that carries the link to the keeper's own door and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-frpc-'));
    const path = join(dir, 'frpc.toml');
    expect(clientFor(settings(), { ...IDENTITY, dir })).toEqual({ program: 'frpc', args: ['-c', path] });
    /* The relay's own config text is not run: whatever it says, only the keeper's door is reachable through the tunnel. */
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
    /* It holds the key of the link. */
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("runs an https proxy to the keeper's TLS listener in https mode, with the visitor's address in a PROXY v2 header", () => {
    expect(configFor(settings({}, { mode: 'https' }), IDENTITY)).toBe(`${ABOVE_THE_PROXY}${HTTPS_PROXY}`);
  });

  it('refuses a mode that is only a name every object inherits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-frpc-'));
    for (const mode of ['toString', 'constructor', '__proto__']) {
      expect(() => clientFor(settings({}, { mode: mode as TunnelSettings['mode'] }), dir), mode).toThrow(`${mode} is not a tunnel mode`);
    }
  });

  it('writes the key so that no character of it can break out of its line', () => {
    expect(configFor(settings({}, { key: 'abc"\nlocalIP = "db' }), IDENTITY)).toContain('metadatas.key = "abc\\"\\nlocalIP = \\"db"\n');
  });

  it('refuses tunnel settings it cannot use', () => {
    for (const bad of [
      settings({ protocol: 'tcp' }),
      settings({ serverAddr: 'hornhoof.org"\nlocalIP = "db' }),
      settings({ serverPort: '443' }),
      settings({ serverPort: 70000 }),
      settings({}, { name: 'Not a name' }),
      settings({}, { key: '' }),
    ]) {
      expect(() => configFor(bad, IDENTITY), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("the link's client id", () => {
  it('is the name, the first 8 characters of the machine id, and link', () => {
    expect(linkClientId('acme', `ab12cd34${'0'.repeat(24)}`)).toBe(CLIENT_ID);
  });

  it("is refused for another link's name, and in any other form", () => {
    for (const clientId of ['globex-ab12cd34-link', 'acmeish-ab12cd34-link', 'acme-AB12CD34-link', 'acme-ab12cd3-link', 'acme-ab12cd34-node', `acme-${'a'.repeat(60)}-ab12cd34-link`, 'acme-ab12cd34-link"\nlocalIP = "db']) {
      expect(() => configFor(settings(), { clientId, local: LOCAL }), clientId).toThrow();
    }
  });
});
