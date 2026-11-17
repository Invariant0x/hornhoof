import { execFile } from 'node:child_process';
import type { OwnerFactory, Peer } from './peer.js';
import { checkProcesses } from '../check-processes.js';

export type Command = (file: string, args: string[], options: { timeout: number }) => Promise<string>;
const command: Command = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, output) => error ? reject(error) : resolve(output));
});

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

async function lsofPid(peer: Peer, run: Command = command): Promise<number | null> {
  const args = ['-nP', '-a', `-iTCP:${peer.port}`, '-sTCP:ESTABLISHED', '-Fpn'];
  const output = await run('/usr/sbin/lsof', args, { timeout: 2000 }).catch(() => '');
  return ownerOf(output, peer);
}

async function parentPid(pid: number, run: Command): Promise<number | null> {
  const output = await run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }).catch(() => '');
  return /^\d+$/.test(output.trim()) ? Number(output.trim()) : null;
}

/* Keep the lineage before a pane lookup can outlast the caller, as the Linux inode check does. */
async function lineageOf(pid: number, run: Command): Promise<Set<number> | null> {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const parent = await parentPid(pid, run);
    if (parent === null) return null;
    pid = parent;
  }
  return seen;
}

export function macOwner(run: Command = command): OwnerFactory {
  return panes => ({
    capture: async peer => ({ acceptedPid: await lsofPid(peer, run) }),
    owns: async (key, peer) => {
      const pid = peer.acceptedPid;
      if (!pid || (peer.pid !== undefined && peer.pid !== pid)) return false;
      const lineage = await lineageOf(pid, run);
      return lineage !== null && [...await panes(key), ...checkProcesses(key)].some(root => lineage.has(root));
    },
  });
}
