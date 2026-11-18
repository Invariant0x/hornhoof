import { execFile, type ExecFileException } from 'node:child_process';
import { basename } from 'node:path';
import { agentRoots, OwnerUnknown, refuse, type OwnerFactory, type Peer } from './peer.js';

export type Command = (file: string, args: string[], options: { timeout: number }) => Promise<string>;
const LOOKUP_MS = 2_000;
/* Leave room for the bridge to reply inside the shortest hook sender's 3 s wait. This covers the pane lookup too. */
const OWNER_LOOKUP_MS = 2_500;

/* A silent exit 1 from lsof can mean no match. An error from ps or an incomplete or diagnostic lsof result gave no answer. */
export function answered(error: ExecFileException | null, output: string, file: string, diagnostic: string): string {
  if (!error) return output;
  if (file === '/usr/sbin/lsof' && error.code === 1 && !error.killed && !output && !diagnostic) return '';
  throw error;
}

const command: Command = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, output, diagnostic) => {
    try { resolve(answered(error, output, file, diagnostic)); } catch (failed) { reject(failed); }
  });
});

async function beforeDeadline<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OwnerUnknown('macOS owner lookup timed out')), OWNER_LOOKUP_MS);
  });
  try { return await Promise.race([read(), expired]); }
  finally { clearTimeout(timer); }
}

/* A command's output, or OwnerUnknown when it gave none. */
async function lookup(run: Command, file: string, args: string[]): Promise<string> {
  try {
    return await run(file, args, { timeout: LOOKUP_MS });
  } catch (error) {
    throw new OwnerUnknown(`${basename(file)} ${(error as { killed?: boolean }).killed ? 'timed out' : 'failed'}`);
  }
}

/* lsof lists both ends. Only the caller's exact local -> remote pair identifies this connection's owner. */
function ownerOf(output: string, peer: Peer): number | null {
  const name = `n127.0.0.1:${peer.port}->127.0.0.1:${peer.bridgePort}`;
  const owners = new Set<number>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = processField(line);
    else if (line === name && pid !== null) owners.add(pid);
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

function processField(field: string): number | null {
  const pid = Number(field.slice(1));
  return /^p[1-9]\d*$/.test(field) && Number.isSafeInteger(pid) ? pid : null;
}

/* The process that holds the caller's end. A call that names its process has lsof look at that one only: a look through
   every process's files outlasted a tool hook's wait on a busy Mac. A call that names none, as MCP and attach calls do, is
   looked for among them all. */
async function socketOwner(peer: Peer, run: Command): Promise<number | null> {
  const only = peer.pid === undefined ? [] : ['-p', String(peer.pid)];
  const owner = ownerOf(await lookup(run, '/usr/sbin/lsof', ['-nP', '-a', ...only, `-iTCP:${peer.port}`, '-sTCP:ESTABLISHED', '-Fpn']), peer);
  return peer.pid === undefined || owner === peer.pid ? owner : null;
}

/* The caller and its ancestors, from one look at the process table taken before a pane lookup can outlast the caller,
   as the Linux inode check does. A caller gone by then has none, and a line that is no pair of numbers leads nowhere: the
   walk stops at anything that is not a process. */
async function lineageOf(pid: number, run: Command): Promise<Set<number>> {
  const parents = new Map<number, number>();
  const table = await lookup(run, '/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
  if (!table.trim()) throw new OwnerUnknown('ps gave no process table');
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    parents.set(child!, parent!);
  }
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 0 && !seen.has(at); at = parents.get(at)) seen.add(at);
  return seen;
}

export function macOwner(run: Command = command): OwnerFactory {
  return panes => ({
    /* Nothing is looked up as a connection opens: the call says which process it comes from. */
    capture: async () => ({}),
    owns: (key, peer, why = () => {}) => beforeDeadline(async () => {
      if (peer.pid !== undefined && !(Number.isSafeInteger(peer.pid) && peer.pid > 0)) return refuse(why, 'malformed pid hint');
      const pid = await socketOwner(peer, run);
      if (!pid) return refuse(why, peer.pid === undefined ? 'no single process holds the connection' : 'the hinted process does not hold the connection');
      const lineage = await lineageOf(pid, run);
      return (await agentRoots(panes, key)).some(root => lineage.has(root)) || refuse(why, "the caller is not under the agent's pane");
    }),
  });
}
