import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLinkName } from '@hornhoof/protocol/link';
import { z } from 'zod';
import type { Client, TunnelSettings } from './tunnel.js';

/* Where frpc hands the link's traffic, by where its TLS ends. */
export type FrpcLocal = { http: { ip: string; port: number }; https: { ip: string; port: number } };
type Identity = { clientId: string; local: FrpcLocal };

/* The parts of the relay's tunnel Hornhoof takes: the frps server and how to reach it. */
export const Server = z.object({
  serverAddr: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
  serverPort: z.number().int().min(1).max(65535),
  protocol: z.literal('wss'),
});

const CLIENT_ID = /^[a-z0-9-]{1,63}-[0-9a-f]{8}-link$/;

/* What https adds: the relay passes TLS on unread, so the tunnel's PROXY header is all that says who the visitor is. */
const LAST_LINES: Record<TunnelSettings['mode'], string> = {
  http: '',
  https: 'transport.proxyProtocolVersion = "v2"\n',
};

/* A TOML string: JSON escapes quotes, backslashes and line breaks the way TOML reads them. */
export const quoted = (text: string) => JSON.stringify(text);

/* The same on every start of this machine's frpc, so the relay knows it for the one that held the link before. */
export const linkClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-link`;

/* How a frpc of Hornhoof reaches the relay, under the id it keeps across its starts. Nothing of the relay's words reaches
   the config unread. */
export function frpcTransport(tunnel: unknown, clientId: string): string {
  const server = Server.parse(tunnel);
  return `serverAddr = ${quoted(server.serverAddr)}
serverPort = ${server.serverPort}
loginFailExit = false
log.to = "console"
log.level = "info"
log.disablePrintColor = true
clientID = ${quoted(clientId)}
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.heartbeatInterval = -1
transport.tcpMuxKeepaliveInterval = 10
`;
}

/* How a frpc of this link logs in at the relay, whatever it then offers: the relay's server, the link's name and key, and
   the id this client keeps across its starts. It refuses a link that is not what a link is. */
export function frpcHead(settings: TunnelSettings, clientId: string): string {
  if (!isLinkName(settings.name)) throw new Error(`${settings.name} is not a link name`);
  if (!settings.key) throw new Error('the link has no key');
  if (!clientId.startsWith(`${settings.name}-`)) throw new Error(`${clientId} is not a client id of this link`);
  return `${frpcTransport(settings.tunnel, clientId)}metadatas.name = ${quoted(settings.name)}
metadatas.key = ${quoted(settings.key)}
metadatas.client = ${quoted(clientId)}
`;
}

/* The frpc config for the link. It is written here and not taken as the relay sends it, so the tunnel carries the
   link's traffic to the keeper's own door and to nothing else on the company's network, whatever the relay says. */
export function configFor(settings: TunnelSettings, { clientId, local }: Identity): string {
  if (!CLIENT_ID.test(clientId)) throw new Error(`${clientId} is not a client id of this link`);
  const head = frpcHead(settings, clientId);
  /* The table's own names only: an object also answers to the names it inherits, such as toString. */
  if (!Object.hasOwn(local, settings.mode)) throw new Error(`${settings.mode} is not a tunnel mode`);
  const door = local[settings.mode];
  return `${head}
[[proxies]]
name = ${quoted(settings.name)}
type = ${quoted(settings.mode)}
subdomain = ${quoted(settings.name)}
localIP = ${quoted(door.ip)}
localPort = ${door.port}
${LAST_LINES[settings.mode]}`;
}

/* frpc with the link's config, written where only this container's user reads it. */
export function clientFor(settings: TunnelSettings, { dir = tmpdir(), ...identity }: Identity & { dir?: string }): Client {
  const path = join(dir, 'frpc.toml');
  writeFileSync(path, configFor(settings, identity), { mode: 0o600 });
  return { program: 'frpc', args: ['-c', path] };
}
