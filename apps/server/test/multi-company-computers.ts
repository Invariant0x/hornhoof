/* The two computers of the multi-company tests, with the installer and the stubs of test/install-stubs: what each has
   on its disk and in its Docker after an install, and the Docker subnets it can route around. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { CODE, install } from './install-script-helpers.js';

export const LAN_ADDR_A = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
].join('\n');
export const LAN_ROUTE_A = ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.10 metric 100', '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10 metric 100'].join('\n');

export const LAN_ADDR_B = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
].join('\n');
export const LAN_ROUTE_B = ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.20 metric 100', '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.20 metric 100'].join('\n');

type CidrRange = { cidr: string; start: number; end: number; prefix: number };

function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}

function parseCidr(cidr: string): CidrRange {
  const [ip, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipToNum(ip) / size) * size;
  return { cidr, start, end: start + size - 1, prefix };
}

export function cidrsOverlap(a: string, b: string): boolean {
  const ra = parseCidr(a);
  const rb = parseCidr(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const n = ipToNum(ip);
  const r = parseCidr(cidr);
  return n >= r.start && n <= r.end;
}

export function envMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

type NetworkRow = { id: string; name: string; project: string; subnet: string; internal: boolean };

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeComputer(ipAddr: string, ipRoute: string) {
  const root = tempDir('hh-machine-');
  const home = join(root, 'home');
  const portsDir = join(root, 'ports');
  mkdirSync(home, { recursive: true });
  mkdirSync(portsDir, { recursive: true });
  const baseEnv = {
    HOME: home,
    HORNHOOF_HOME: join(home, '.hornhoof'),
    HORNHOOF_DIR: join(home, 'hornhoof'),
    STUB_PORTS_DIR: portsDir,
    STUB_REAL_COMPOSE: '1',
    STUB_IP_ADDR: ipAddr,
    STUB_IP_ROUTE: ipRoute,
  };
  return {
    root,
    home,
    portsDir,
    folder: (name = 'hornhoof', userHome = home) => join(userHome, name),
    dotEnv: (name = 'hornhoof', userHome = home) => envMap(readFileSync(join(userHome, name, '.env'), 'utf8')),
    registry: () => (existsSync(join(portsDir, 'registry')) ? readFileSync(join(portsDir, 'registry'), 'utf8').trim().split('\n').filter(Boolean) : []),
    subnets: () => (existsSync(join(portsDir, 'subnets')) ? readFileSync(join(portsDir, 'subnets'), 'utf8').trim().split('\n').filter(Boolean) : []),
    networks: (): NetworkRow[] => {
      if (!existsSync(join(portsDir, 'networks'))) return [];
      return readFileSync(join(portsDir, 'networks'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [id = '', name = '', project = '', subnet = '', internal = 'false'] = line.split('|');
          return { id, name, project, subnet: subnet.replace(/,.*$/, ''), internal: internal === 'true' };
        });
    },
    runServer: (args: string[] = [], env: Record<string, string> = {}, tty = '\n') =>
      install({ args: ['server', ...args], tty, env: { ...baseEnv, ...env } }),
    runJoin: (args: string[] = [], env: Record<string, string> = {}, tty = '\n') =>
      install({ args: ['--join', CODE, ...args], tty, env: { ...baseEnv, ...env } }),
  };
}
