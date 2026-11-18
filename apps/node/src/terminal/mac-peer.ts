import { execFile, type ExecFileException } from 'node:child_process';
import { basename } from 'node:path';
import { agentRoots, OwnerUnknown, refuse, type OwnerFactory, type Peer } from './peer.js';

export type Command = (file: string, args: string[], options: { timeout: number; signal?: AbortSignal }) => Promise<string>;
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

async function beforeDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new OwnerUnknown('macOS owner lookup timed out');
      cancellation.abort(reason);
      reject(reason);
    }, OWNER_LOOKUP_MS);
  });
  try { return await Promise.race([read(cancellation.signal), expired]); }
  finally { clearTimeout(timer); }
}

/* A command's output, or OwnerUnknown when it gave none. */
async function lookup(run: Command, file: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  try {
    const output = await run(file, args, { timeout: LOOKUP_MS, signal });
    signal.throwIfAborted();
    return output;
  } catch (error) {
    signal.throwIfAborted();
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

/* Check the known process first when possible. A match in that process still needs a check for other holders. */
async function socketOwner(peer: Peer, run: Command, signal: AbortSignal, pid?: number): Promise<number | null> {
  const only = pid === undefined ? [] : ['-p', String(pid)];
  return ownerOf(await lookup(run, '/usr/sbin/lsof', ['-nP', '-a', ...only, `-iTCP:${peer.port}`, '-sTCP:ESTABLISHED', '-Fpn'], signal), peer);
}

/* Use only observed process rows, from the caller through launchd. A partial snapshot gives no answer. */
function processLineage(table: string, pid: number): Set<number> {
  const rows = table.trim();
  if (!rows) throw new OwnerUnknown('ps gave no process table');
  const parents = new Map<number, number>();
  for (const line of rows.split('\n')) {
    const fields = /^([1-9]\d*)\s+(0|[1-9]\d*)$/.exec(line.trim());
    if (!fields) throw new OwnerUnknown('ps gave an invalid process table');
    const child = Number(fields[1]), parent = Number(fields[2]);
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent) || parents.has(child)) throw new OwnerUnknown('ps gave an invalid process table');
    parents.set(child, parent);
  }
  const seen = new Set<number>();
  for (let at = pid; at > 0;) {
    if (seen.has(at)) throw new OwnerUnknown('ps gave a cyclic process lineage');
    const parent = parents.get(at);
    if (parent === undefined) throw new OwnerUnknown('ps gave an incomplete process lineage');
    seen.add(at);
    at = parent;
  }
  return seen;
}

export function macOwner(run: Command = command): OwnerFactory {
  return panes => ({
    /* Nothing is looked up as a connection opens: the call says which process it comes from. */
    capture: async () => ({}),
    owns: (key, peer, why = () => {}) => beforeDeadline(async signal => {
      if (peer.pid !== undefined && !(Number.isSafeInteger(peer.pid) && peer.pid > 0)) return refuse(why, 'malformed pid hint');
      if (peer.pid !== undefined && (await socketOwner(peer, run, signal, peer.pid)) !== peer.pid) {
        return refuse(why, 'the hinted process does not hold the connection');
      }
      const pid = await socketOwner(peer, run, signal);
      if (pid === null) return refuse(why, 'no single process holds the connection');
      if (peer.pid !== undefined && pid !== peer.pid) return refuse(why, 'the hinted process does not hold the connection');
      const table = await lookup(run, '/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], signal);
      const lineage = processLineage(table, pid);
      return (await agentRoots(panes, key, signal)).some(root => lineage.has(root)) || refuse(why, "the caller is not under the agent's pane");
    }),
  });
}
