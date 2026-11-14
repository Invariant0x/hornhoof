import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLinkName } from '@hornhoof/protocol/link';
import { NETWORK_ID } from '../network/ids.js';
import { frpcTransport, quoted } from './client.js';
import { serviceName } from './peer-client.js';
import type { Client } from './tunnel.js';

/* The same on every start of a worker's frpc, which visits the services of the company's data machines and offers none. */
export const visitClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-visit`;

/* The app of the first data machine is at this port of the keeper's own loopback, the next one's at the next. */
export const VISIT_FIRST_PORT = 7090;

/* What a worker holds of the link: where the relay is, the key that logs a visitor in, and the secret of the data
   machines' app service. It holds neither the link's key nor the way to the data. */
export type VisitSettings = { name: string; serverAddr: string; serverPort: number; visitorKey: string; appSecret: string; dataSecret?: string };

/* machineId: this keeper's id in the network; targets: the ids of the data machines' keepers, which their services are
   named after. kind: which of a data machine's two services is visited: its app, as a worker does, or its peer link
   with the way to the data, which takes the secret only machines that keep data are given. */
type Visit = { machineId: string; targets: string[]; kind?: 'app' | 'data' };


function visitor(link: VisitSettings, from: string, target: string, port: number, kind: 'app' | 'data'): string {
  if (!NETWORK_ID.test(target)) throw new Error(`${target} is not a machine id`);
  const secret = kind === 'data' ? link.dataSecret : link.appSecret;
  if (!secret) throw new Error('the link has no data secret');
  return `
[[visitors]]
name = ${quoted(`${link.name}-${from.slice(0, 8)}-to-${target.slice(0, 8)}${kind === 'data' ? '-data' : ''}`)}
type = "stcp"
serverName = ${quoted(serviceName(link.name, target, kind))}
secretKey = ${quoted(secret)}
bindAddr = "127.0.0.1"
bindPort = ${port}
`;
}

/* The frpc config of a worker: it logs in at the relay as a visitor of the link and opens each data machine's app
   service at a loopback port of its own. It is written here, so nothing but those ports comes of whatever the server said. */
export function visitConfigFor(link: VisitSettings, { machineId, targets, kind = 'app' }: Visit): string {
  if (!isLinkName(link.name)) throw new Error(`${link.name} is not a link name`);
  if (!link.visitorKey) throw new Error('the link has no visitor key');
  if (!NETWORK_ID.test(machineId)) throw new Error(`${machineId} is not a machine id`);
  const clientId = visitClientId(link.name, machineId);
  const head = `${frpcTransport({ serverAddr: link.serverAddr, serverPort: link.serverPort, protocol: 'wss' }, clientId)}metadatas.name = ${quoted(link.name)}
metadatas.visitor = ${quoted(link.visitorKey)}
metadatas.client = ${quoted(clientId)}
`;
  return head + targets.map((target, i) => visitor(link, machineId, target, VISIT_FIRST_PORT + i, kind)).join('');
}

/* frpc with that config, in a file of its own in the keeper's folder. */
export function visitClientFor(link: VisitSettings, { dir = tmpdir(), ...visit }: Visit & { dir?: string }): Client {
  const path = join(dir, 'frpc-visit.toml');
  writeFileSync(path, visitConfigFor(link, visit), { mode: 0o600 });
  return { program: 'frpc', args: ['-c', path] };
}
