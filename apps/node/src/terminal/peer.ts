import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkProcesses } from '../check-processes.js';

/* A connection to the bridge: the caller's port and the bridge's, both on 127.0.0.1. */
export type Peer = { port: number; bridgePort: number; pid?: number; acceptedInode?: string | null };
/* Whether the connection comes from the agent's own program; why hears the reason when it does not. A lookup that gives
   no answer throws OwnerUnknown instead. */
export type Owns = (key: string, peer: Peer, why?: (reason: string) => void) => Promise<boolean>;
export type Capture = (peer: Peer) => Promise<Pick<Peer, 'acceptedInode'>>;
export type Panes = (key: string, signal?: AbortSignal) => Promise<number[]>;
export type Ownership = { owns: Owns | null; capture?: Capture };
export type OwnerFactory = (panes: Panes) => Ownership;
/* How much of the machine one owner check may read: the most processes, and how long the look may hold the node. */
export type LookBounds = { processes?: number; ms?: number; now?: () => number };

/* A look at the machine's processes that gave no answer, as a command out of time does: the bridge asks the caller to try
   again and keeps nothing of it. Its message names the lookup without including its input or output. */
export class OwnerUnknown extends Error {}

/* A caller whose end of the connection had closed before the node could look at it: refused, as nothing proves whose it
   was, but no foreign caller either. */
export const CALLER_LEFT = 'the caller left before its owner check';

/* Refuses with its reason. */
export function refuse(why: (reason: string) => void, reason: string): false {
  why(reason);
  return false;
}

/* The processes an agent's calls come from: its panes', and the check commands the bridge started for it. */
export async function agentRoots(panes: Panes, key: string, signal?: AbortSignal): Promise<number[]> {
  signal?.throwIfAborted();
  try {
    const found = await panes(key, signal);
    signal?.throwIfAborted();
    return [...found, ...checkProcesses(key)];
  } catch {
    signal?.throwIfAborted();
    throw new OwnerUnknown('tmux pane lookup failed');
  }
}

/* The connection is looked up as the node accepts it, before anything else the node has to do. */
export function procOwner(proc: string): OwnerFactory {
  return panes => ({ owns: fromAgent(panes, proc), capture: async peer => ({ acceptedInode: tcpInode(proc, peer) }) });
}

const LOCAL = '0100007F';
const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
type TerminalSession = { session: number; tty: number };
/* A busy machine runs a few hundred processes, and the node reads each in about twenty microseconds. */
const MAX_PROCESSES = 4096;
const MAX_LOOK_MS = 500;

/* Raised when a look would read more of the machine than its bounds let it; the check refuses with its reason. */
class OverBounds extends Error {}

/* One look at the machine, read at once and so never behind the node's other work, but bounded so as not to hold that
   work up for long either. */
class Look {
  private readonly started: number;
  constructor(private readonly bounds: Required<LookBounds>) {
    this.started = bounds.now();
  }

  count(processes: number): void {
    if (processes > this.bounds.processes) throw new OverBounds('the machine runs more processes than one owner check may read');
  }

  step(): void {
    if (this.bounds.now() - this.started > this.bounds.ms) throw new OverBounds('the owner check ran out of its time on this machine');
  }
}

/* A read of the machine: nothing when what it reads is gone, and no answer when it cannot be read. */
function read<T>(look: () => T, reason: string): T | undefined {
  try {
    return look();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    throw new OwnerUnknown(reason);
  }
}

/* The fields of a process's stat after its name, which may hold spaces and brackets. */
const fieldsOf = (stat: string) => stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
const parentOf = (fields: string[]) => Number(fields[1]);

function sessionOf(fields: string[]): TerminalSession | null {
  const session = Number(fields[3]), tty = Number(fields[4]);
  return Number.isSafeInteger(session) && session > 0 && Number.isSafeInteger(tty) && tty > 0 ? { session, tty } : null;
}

function terminalSession(proc: string, pid: number): TerminalSession | null {
  const stat = read(() => readFileSync(join(proc, String(pid), 'stat'), 'utf8'), 'Linux terminal session lookup failed');
  return stat ? sessionOf(fieldsOf(stat)) : null;
}

/* Reparenting changes ppid, but not the kernel session or controlling terminal. An outside process cannot join this
   session. Require its live leader to be the exact pane pid tmux named, not merely another process on the same tty. */
function inPaneSession(caller: TerminalSession | null, leader: TerminalSession | null | undefined, roots: number[]): boolean {
  return Boolean(caller && roots.includes(caller.session) && leader?.session === caller.session && leader.tty === caller.tty);
}

/* The socket of the caller's end, from the kernel's table of TCP connections, read at once. */
function tcpInode(proc: string, { port, bridgePort }: Peer): string | null {
  const table = read(() => readFileSync(join(proc, 'net', 'tcp'), 'utf8'), 'Linux TCP table read failed');
  if (table === undefined) throw new OwnerUnknown('Linux TCP table read failed');
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === `${LOCAL}:${hex(port)}` && cols[2] === `${LOCAL}:${hex(bridgePort)}` && cols[9] && cols[9] !== '0') return cols[9];
  }
  return null;
}

export async function socketOf(proc: string, peer: Peer): Promise<string | null> {
  return tcpInode(proc, peer);
}

function holds(proc: string, pid: number, link: string, look: Look): boolean {
  const path = join(proc, String(pid), 'fd');
  const fds = read(() => readdirSync(path), 'Linux file descriptor lookup failed') ?? [];
  return fds.some(fd => {
    look.step();
    return read(() => readlinkSync(join(path, fd)), 'Linux file descriptor lookup failed') === link;
  });
}

/* Agents of one plan share a Linux user, so the secret in a bridge address is no proof: any of them can read another's
   command line. The kernel tells which process holds the caller's end of the connection, and the call is the agent's
   only when that process runs under the agent's own pane or in that pane's live terminal session. All of it is read the
   moment the call arrives: a node a loaded machine starves would otherwise read it only after its caller gave up. */
export function fromAgent(panes: Panes, proc = '/proc', bounds: LookBounds = {}): Owns {
  const limits = { processes: MAX_PROCESSES, ms: MAX_LOOK_MS, now: () => performance.now(), ...bounds };
  return async (key, peer, why = () => {}) => {
    const inode = peer.acceptedInode === undefined ? tcpInode(proc, peer) : peer.acceptedInode;
    if (!inode) return refuse(why, CALLER_LEFT);
    const link = `socket:[${inode}]`;
    const roots = () => agentRoots(panes, key);
    try {
      if (peer.pid !== undefined) return await hintedOwner(proc, { ...peer, pid: peer.pid }, inode, roots, new Look(limits), why);
      return await underPanes(proc, await roots(), link, new Look(limits), why);
    } catch (error) {
      if (error instanceof OverBounds) return refuse(why, error.message);
      throw error;
    }
  };
}

/* What the kernel says of the hinted caller as its call arrives. */
type Caller = { lineage: Set<number>; session: TerminalSession | null; leader: TerminalSession | null };

/* The pid is only a hint: its fd must hold the exact inode captured for this connection, never a socket named by the
   caller. A hinted process that is gone left before its check when its end of the connection closed with it. */
async function hintedOwner(proc: string, peer: Peer & { pid: number }, inode: string, panes: () => Promise<number[]>, look: Look, why: (reason: string) => void): Promise<boolean> {
  const { pid } = peer;
  if (!Number.isSafeInteger(pid) || pid <= 0) return refuse(why, 'malformed pid hint');
  if (!read(() => statSync(join(proc, String(pid))), 'Linux hinted process lookup failed')) return refuse(why, tcpInode(proc, peer) === inode ? 'the hinted process is not running' : CALLER_LEFT);
  if (!holds(proc, pid, `socket:[${inode}]`, look)) return refuse(why, 'the hinted process does not hold the connection');
  const caller = callerOf(proc, pid, look);
  const roots = await panes();
  return roots.some(root => caller.lineage.has(root)) || inPaneSession(caller.session, caller.leader, roots) || refuse(why, "the caller is not under the agent's pane");
}

function callerOf(proc: string, pid: number, look: Look): Caller {
  const lineage = ancestors(proc, pid, look);
  const session = terminalSession(proc, pid);
  return { lineage, session, leader: session ? terminalSession(proc, session.session) : null };
}

function ancestors(proc: string, pid: number, look: Look): Set<number> {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    look.step();
    const stat = read(() => readFileSync(join(proc, String(pid), 'stat'), 'utf8'), 'Linux process ancestry lookup failed');
    if (!stat) break;
    seen.add(pid);
    pid = parentOf(fieldsOf(stat));
  }
  return seen;
}

/* Every process, with its parent and terminal session, read in one pass. */
type Machine = { children: Map<number, number[]>; sessions: Map<number, TerminalSession | null> };

function machine(proc: string, look: Look): Machine {
  const names = read(() => readdirSync(proc), 'Linux process directory read failed');
  if (!names) throw new OwnerUnknown('Linux process directory read failed');
  const pids = names.filter(name => /^\d+$/.test(name));
  look.count(pids.length);
  const found: Machine = { children: new Map(), sessions: new Map() };
  for (const name of pids) {
    look.step();
    const stat = read(() => readFileSync(join(proc, name, 'stat'), 'utf8'), 'Linux process tree lookup failed');
    if (stat) placed(found, Number(name), fieldsOf(stat));
  }
  return found;
}

function placed(found: Machine, pid: number, fields: string[]): void {
  found.sessions.set(pid, sessionOf(fields));
  const parent = parentOf(fields);
  if (Number.isInteger(parent)) found.children.set(parent, [...(found.children.get(parent) ?? []), pid]);
}

/* A call that sends no pid, as MCP and attach calls and older hook programs do, is searched for in the pane's descendants,
   then among the processes left in the pane's session. */
async function underPanes(proc: string, roots: number[], link: string, look: Look, why: (reason: string) => void): Promise<boolean> {
  if (!roots.length) return refuse(why, 'the agent has no pane');
  const { children, sessions } = machine(proc, look);
  const seen = new Set<number>();
  for (const queue = [...roots]; queue.length; ) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (holds(proc, pid, link, look)) return true;
    queue.push(...(children.get(pid) ?? []));
  }
  for (const [pid, session] of sessions) {
    if (!seen.has(pid) && inPaneSession(session, session && sessions.get(session.session), roots) && holds(proc, pid, link, look)) return true;
  }
  return refuse(why, "no process under the agent's pane holds the connection");
}
