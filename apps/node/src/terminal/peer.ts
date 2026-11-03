import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/* A connection to the bridge: the caller's port and the bridge's, both on 127.0.0.1. */
export type Peer = { port: number; bridgePort: number; pid?: number; acceptedInode?: string | null; acceptedPid?: number | null };
/* Whether the connection comes from the agent's own program. */
export type Owns = (key: string, peer: Peer) => Promise<boolean>;
export type Capture = (peer: Peer) => Promise<Pick<Peer, 'acceptedInode' | 'acceptedPid'>>;
export type Panes = (key: string) => Promise<number[]>;
export type Ownership = { owns: Owns | null; capture?: Capture };
export type OwnerFactory = (panes: Panes) => Ownership;

export function procOwner(proc: string): OwnerFactory {
  return panes => ({ owns: fromAgent(panes, proc), capture: async peer => ({ acceptedInode: await socketOf(proc, peer) }) });
}

const LOCAL = '0100007F';
const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');

/* The socket of the caller's end, from the kernel's table of TCP connections. */
export async function socketOf(proc: string, { port, bridgePort }: Peer): Promise<string | null> {
  const table = await readFile(join(proc, 'net', 'tcp'), 'utf8').catch(() => '');
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === `${LOCAL}:${hex(port)}` && cols[2] === `${LOCAL}:${hex(bridgePort)}` && cols[9] && cols[9] !== '0') return cols[9];
  }
  return null;
}

/* Each process with the processes it started. The name in stat may hold spaces and brackets, so the parent comes after the last one. */
async function children(proc: string): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  for (const name of await readdir(proc).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(join(proc, name, 'stat'), 'utf8').catch(() => '');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isInteger(parent)) continue;
    out.set(parent, [...(out.get(parent) ?? []), Number(name)]);
  }
  return out;
}

async function holds(proc: string, pid: number, link: string): Promise<boolean> {
  const fds = await readdir(join(proc, String(pid), 'fd')).catch(() => []);
  for (const fd of fds) if ((await readlink(join(proc, String(pid), 'fd', fd)).catch(() => '')) === link) return true;
  return false;
}

/* Agents of one plan share a Linux user, so the secret in a bridge address is no proof: any of them can read another's
   command line. The kernel tells which process holds the caller's end of the connection, and the call is the agent's
   only when that process runs under the agent's own pane. */
export function fromAgent(panes: (key: string) => Promise<number[]>, proc = '/proc'): Owns {
  return async (key, peer) => {
    const inode = peer.acceptedInode === undefined ? await socketOf(proc, peer) : peer.acceptedInode;
    if (!inode) return false;
    const link = `socket:[${inode}]`;
    if (peer.pid !== undefined) return hintedOwner(proc, peer.pid, link, () => panes(key));
    return underPanes(proc, await panes(key), link);
  };
}

/* Capture the caller's lineage while it is alive, before a slow pane lookup. The pid is only a hint: its fd must hold
   the exact inode captured for this connection, never a socket named by the caller. */
async function hintedOwner(proc: string, pid: number, link: string, panes: () => Promise<number[]>): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !(await holds(proc, pid, link))) return false;
  const lineage = await ancestors(proc, pid);
  return (await panes()).some(root => lineage.has(root));
}

async function ancestors(proc: string, pid: number): Promise<Set<number>> {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const stat = await readFile(join(proc, String(pid), 'stat'), 'utf8').catch(() => '');
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return seen;
}

/* Older hook programs send no pid. Keep their kernel-backed search under the pane's descendants. */
async function underPanes(proc: string, roots: number[], link: string): Promise<boolean> {
  if (!roots.length) return false;
  const tree = await children(proc);
  const seen = new Set<number>();
  for (const queue = [...roots]; queue.length; ) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (await holds(proc, pid, link)) return true;
    queue.push(...(tree.get(pid) ?? []));
  }
  return false;
}
