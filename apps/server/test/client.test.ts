import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientFor } from '../src/modules/link/client.js';
import type { TunnelSettings } from '../src/modules/link/tunnel.js';

const KEY = 'Zm9vYmFyLWtleS1vZi10aGUtYmluZGluZy0wMTIzNDU2';

/* What the app writes for a link, with the tunnel as the relay hands it out, including its own config text. */
const settings = (tunnel: Record<string, unknown> = {}, more: Partial<TunnelSettings> = {}): TunnelSettings => ({
  url: 'https://acme.hornhoof.org',
  name: 'acme',
  key: KEY,
  tunnel: { serverAddr: 'hornhoof.org', serverPort: 443, protocol: 'wss', config: 'localIP = "db"\nlocalPort = 5432\n', ...tunnel },
  ...more,
});

const CONFIG = `serverAddr = "hornhoof.org"
serverPort = 443
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
metadatas.name = "acme"
metadatas.key = "${KEY}"

[[proxies]]
name = "acme"
type = "http"
subdomain = "acme"
localIP = "app"
localPort = 8080
requestHeaders.set.x-forwarded-proto = "https"
`;

describe('the tunnel client', () => {
  it('runs frpc with a config that carries the link to the app and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-frpc-'));
    const path = join(dir, 'frpc.toml');
    expect(clientFor(settings(), dir)).toEqual({ program: 'frpc', args: ['-c', path] });
    /* The relay's own config text is not run: whatever it says, only the app is reachable through the tunnel. */
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
    /* It holds the key of the link. */
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('writes the key so that no character of it can break out of its line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-frpc-'));
    clientFor(settings({}, { key: 'abc"\nlocalIP = "db' }), dir);
    expect(readFileSync(join(dir, 'frpc.toml'), 'utf8')).toContain('metadatas.key = "abc\\"\\nlocalIP = \\"db"\n');
  });

  it('refuses tunnel settings it cannot use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-frpc-'));
    for (const bad of [
      settings({ protocol: 'tcp' }),
      settings({ serverAddr: 'hornhoof.org"\nlocalIP = "db' }),
      settings({ serverPort: '443' }),
      settings({ serverPort: 70000 }),
      settings({}, { name: 'Not a name' }),
      settings({}, { key: '' }),
    ]) {
      expect(() => clientFor(bad, dir), JSON.stringify(bad)).toThrow();
    }
  });
});
