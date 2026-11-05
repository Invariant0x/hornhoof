import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLinkName } from '@hornhoof/protocol/link';
import { z } from 'zod';
import { LINK_TLS_PORT } from '../tls/listener.js';
import type { Client, TunnelSettings } from './tunnel.js';

/* The parts of the relay's tunnel Hornhoof takes: the frps server and how to reach it. */
const Server = z.object({
  serverAddr: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  serverPort: z.number().int().min(1).max(65535),
  protocol: z.literal('wss'),
});

/* What differs by where the link's TLS ends. At the relay, the app hears from the tunnel that a request came over https.
   At the app, the relay passes TLS on unread, so the tunnel's PROXY header is all that says who the visitor is. */
const PROXY: Record<TunnelSettings['mode'], { localPort: number; lastLine: string }> = {
  http: { localPort: 8080, lastLine: 'requestHeaders.set.x-forwarded-proto = "https"' },
  https: { localPort: LINK_TLS_PORT, lastLine: 'transport.proxyProtocolVersion = "v2"' },
};

/* A TOML string: JSON escapes quotes, backslashes and line breaks the way TOML reads them. */
const quoted = (text: string) => JSON.stringify(text);

/* The frpc config for the link. It is written here and not taken as the relay sends it, so the tunnel carries the
   link's traffic to the app and to nothing else on the company's network, whatever the relay says. */
function configFor(settings: TunnelSettings): string {
  const server = Server.parse(settings.tunnel);
  if (!isLinkName(settings.name)) throw new Error(`${settings.name} is not a link name`);
  if (!settings.key) throw new Error('the link has no key');
  const proxy = PROXY[settings.mode];
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
type = ${quoted(settings.mode)}
subdomain = ${quoted(settings.name)}
localIP = "app"
localPort = ${proxy.localPort}
${proxy.lastLine}
`;
}

/* frpc with the link's config, written where only this container's user reads it. */
export function clientFor(settings: TunnelSettings, dir = tmpdir()): Client {
  const path = join(dir, 'frpc.toml');
  writeFileSync(path, configFor(settings), { mode: 0o600 });
  return { program: 'frpc', args: ['-c', path] };
}
