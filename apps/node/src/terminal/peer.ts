import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkProcesses } from '../check-processes.js';

/* A connection to the bridge: the caller's port and the bridge's, both on 127.0.0.1. */
export type Peer = { port: number; bridgePort: number; pid?: number; acceptedInode?: string | null };
/* Whether the connection comes from the agent's own program; why hears the reason when it does not. A lookup that gives
   no answer throws OwnerUnknown instead. */
export type Owns = (key: string, peer: Peer, why?: (reason: string) => void) => Promise<boolean>;
export type Capture = (peer: Peer) => Promise<Pick<Peer, 'acceptedInode'>>;
export type Panes = (key: string) => Promise<number[]>;
export type Ownership = { owns: Owns | null; capture?: Capture };
export type OwnerFactory = (panes: Panes) => Ownership;

/* A look at the machine's processes that gave no answer, as a command out of time does: the bridge asks the caller to try
   again and keeps nothing of it. Its message names the lookup without including its input or output. */
export class OwnerUnknown extends Error {}

/* Refuses with its reason. */
export function refuse(why: (reason: string) => void, reason: string): false {
  why(reason);
  return false;
}

/* The processes an agent's calls come from: its panes', and the check commands the bridge started for it. */
export async function agentRoots(panes: Panes, key: string): Promise<number[]> {
  const found = await panes(key).catch(() => { throw new OwnerUnknown('tmux pane lookup failed'); });
  return [...found, ...checkProcesses(key)];
}

export function procOwner(proc: string): OwnerFactory {
  return panes => ({ owns: fromAgent(panes, proc), capture: async peer => ({ acceptedInode: await socketOf(proc, peer) }) });
}

const LOCAL = '0100007F';
const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
type TerminalSession = { session: number; tty: number };

async function terminalSession(proc: string, pid: number): Promise<TerminalSession | null> {
  const stat = await readFile(join(proc, String(pid), 'stat'), 'utf8').catch(() => '');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const session = Number(fields[3]), tty = Number(fields[4]);
  return Number.isSafeInteger(session) && session > 0 && Number.isSafeInteger(tty) && tty > 0 ? { session, tty } : null;
}

/* Reparenting changes ppid, but not the kernel session or controlling terminal. An outside process cannot join this
   session. Require its live leader to be the exact pane pid tmux named, not merely another process on the same tty. */
async function inPaneSession(proc: string, caller: TerminalSession | null, roots: number[]): Promise<boolean> {
  if (!caller || !roots.includes(caller.session)) return false;
  const leader = await terminalSession(proc, caller.session);
  return leader?.session === caller.session && leader.tty === caller.tty;
}

/* The socket of the caller's end, from the kernel's table of TCP connections. */
export async function socketOf(proc: string, { port, bridgePort }: Peer): Promise<string | null> {
  const table = await readFile(join(proc, 'net', 'tcp'), 'utf8').catch(() => { throw new OwnerUnknown('Linux TCP table read failed'); });
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
   only when that process runs under the agent's own pane or in that pane's live terminal session. */
export function fromAgent(panes: Panes, proc = '/proc'): Owns {
  return async (key, peer, why = () => {}) => {
    const inode = peer.acceptedInode === undefined ? await socketOf(proc, peer) : peer.acceptedInode;
    if (!inode) return refuse(why, 'the connection is not in the socket table');
    const link = `socket:[${inode}]`;
    const roots = () => agentRoots(panes, key);
    if (peer.pid !== undefined) return hintedOwner(proc, peer.pid, link, roots, why);
    return underPanes(proc, await roots(), link, why);
  };
}

/* Capture the caller's lineage while it is alive, before a slow pane lookup. The pid is only a hint: its fd must hold
   the exact inode captured for this connection, never a socket named by the caller. */
async function hintedOwner(proc: string, pid: number, link: string, panes: () => Promise<number[]>, why: (reason: string) => void): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return refuse(why, 'malformed pid hint');
  if (!(await stat(join(proc, String(pid))).then(() => true, () => false))) return refuse(why, 'the hinted process is gone, as a caller that gave up before its check is');
  if (!(await holds(proc, pid, link))) return refuse(why, 'the hinted process does not hold the connection');
  const lineage = await ancestors(proc, pid);
  const caller = await terminalSession(proc, pid);
  const roots = await panes();
  return roots.some(root => lineage.has(root)) || (await inPaneSession(proc, caller, roots)) || refuse(why, "the caller is not under the agent's pane");
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

/* A call that sends no pid, as MCP and attach calls and older hook programs do, is searched for in the pane's descendants. */
async function underPanes(proc: string, roots: number[], link: string, why: (reason: string) => void): Promise<boolean> {
  if (!roots.length) return refuse(why, 'the agent has no pane');
  const tree = await children(proc);
  const seen = new Set<number>();
  for (const queue = [...roots]; queue.length; ) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (await holds(proc, pid, link)) return true;
    queue.push(...(tree.get(pid) ?? []));
  }
  for (const pids of tree.values()) for (const pid of pids) {
    if (!seen.has(pid) && await inPaneSession(proc, await terminalSession(proc, pid), roots) && await holds(proc, pid, link)) return true;
  }
  return refuse(why, "no process under the agent's pane holds the connection");
}
