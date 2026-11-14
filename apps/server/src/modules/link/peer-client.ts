import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frpcHead, quoted } from './client.js';
import type { Client, TunnelSettings } from './tunnel.js';

/* The same on every start of this machine's second frpc, which offers the machine to its peers. */
export const peerClientId = (name: string, machineId: string): string => `${name}-${machineId.slice(0, 8)}-peer`;

/* The two services a machine offers its peers through hornhoof.org: its peer link, for machines that keep data, and its
   app alone, for every machine of the company. */
export const serviceName = (name: string, machineId: string, kind: 'data' | 'app'): string => `${name}-${machineId.slice(0, 8)}-${kind}`;

export type PeerServices = { settings: TunnelSettings; secrets: { data: string; app: string } };
type Offer = { machineId: string; local: { data: number; app: number } };

/* A secret service: only a visitor that knows the secret reaches it, and the relay carries what passes unread. */
const service = (name: string, secret: string, port: number): string => `
[[proxies]]
name = ${quoted(name)}
type = "stcp"
secretKey = ${quoted(secret)}
localIP = "127.0.0.1"
localPort = ${port}
`;

/* The frpc config that offers the peer link and the app. It is written here, so each service reaches this keeper's own
   two doors and nothing else on the company's network, whatever the relay says. */
export function peerConfigFor({ settings, secrets }: PeerServices, { machineId, local }: Offer): string {
  const head = frpcHead(settings, peerClientId(settings.name, machineId));
  return `${head}${service(serviceName(settings.name, machineId, 'data'), secrets.data, local.data)}${service(serviceName(settings.name, machineId, 'app'), secrets.app, local.app)}`;
}

/* frpc with that config, in a file of its own beside the link's, so the two children never share one. */
export function peerClientFor(services: PeerServices, { dir = tmpdir(), ...offer }: Offer & { dir?: string }): Client {
  const path = join(dir, 'frpc-peer.toml');
  writeFileSync(path, peerConfigFor(services, offer), { mode: 0o600 });
  return { program: 'frpc', args: ['-c', path] };
}
