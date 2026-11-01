import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLinkName } from '@hornhoof/protocol/link';
import { z } from 'zod';
import type { Client, TunnelSettings } from './tunnel.js';

/* The parts of the relay's tunnel Hornhoof takes: the frps server and how to reach it. */
const Server = z.object({
  serverAddr: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  serverPort: z.number().int().min(1).max(65535),
  protocol: z.literal('wss'),
});

/* A TOML string: JSON escapes quotes, backslashes and line breaks the way TOML reads them. */
const quoted = (text: string) => JSON.stringify(text);

/* The frpc config for the link. It is written here and not taken as the relay sends it, so the tunnel carries the
   link's traffic to the app and to nothing else on the company's network, whatever the relay says. */
function configFor(settings: TunnelSettings): string {
  const server = Server.parse(settings.tunnel);
  if (!isLinkName(settings.name)) throw new Error(`${settings.name} is not a link name`);
  if (!settings.key) throw new Error('the link has no key');
  return `serverAddr = ${quoted(server.serverAddr)}
serverPort = ${server.serverPort}
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
metadatas.name = ${quoted(settings.name)}
metadatas.key = ${quoted(settings.key)}

[[proxies]]
name = ${quoted(settings.name)}
type = "http"
subdomain = ${quoted(settings.name)}
localIP = "app"
localPort = 8080
requestHeaders.set.x-forwarded-proto = "https"
`;
}

/* frpc with the link's config, written where only this container's user reads it. */
export function clientFor(settings: TunnelSettings, dir = tmpdir()): Client {
  const path = join(dir, 'frpc.toml');
  writeFileSync(path, configFor(settings), { mode: 0o600 });
  return { program: 'frpc', args: ['-c', path] };
}
