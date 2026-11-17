import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type CheckGroup = { pid: number; started: string };
export type GroupProcess = CheckGroup & { parent: number; group: number; session: number; uid: number; state: string };

/* Birth time is the kernel's starttime field, never a wall clock. Read it around the owner lookup so PID reuse cannot
   combine one process's stat with another one's uid. Names in stat can contain spaces and closing parentheses. */
export async function checkGroupProcess(pid: number, proc = '/proc'): Promise<GroupProcess | null> {
  try {
    const path = join(proc, String(pid));
    const text = await readFile(join(path, 'stat'), 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    const owner = await stat(path);
    const again = await readFile(join(path, 'stat'), 'utf8');
    const latest = again.slice(again.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (latest[19] !== fields[19]) throw new Error('Check group PID changed.');
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('Invalid check group birth time.');
    return { pid, started: fields[19], state: fields[0]!, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), uid: owner.uid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw error;
  }
}

export async function checkGroupMembers(group: CheckGroup): Promise<GroupProcess[]> {
  const names = await readdir('/proc');
  const members: GroupProcess[] = [];
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const member = await checkGroupProcess(Number(name));
    if (member?.group === group.pid && member.state !== 'Z' && member.state !== 'X') members.push(member);
  }
  return members;
}

export async function assertCheckGroup(group: CheckGroup, uid: number, caller: number | undefined, inspect = checkGroupProcess): Promise<void> {
  const leader = await inspect(group.pid);
  if (!caller || uid === 0 || !leader || leader.parent !== caller || leader.uid !== uid || leader.group !== group.pid || leader.session !== group.pid || leader.started !== group.started) {
    throw new Error('The check group is not the caller\'s own waiting group.');
  }
}

/* Signals run as the group's user, including when the node is root. The identity guard and kill are in one synchronous
   helper turn. Without the original waiting leader, cleanup refuses to signal a possibly recycled group id. */
const SIGNAL_GROUP = String.raw`
const fs = require('node:fs');
const [pid, started, group, uid, signal] = process.argv.slice(1);
try {
  const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields[19] !== started || fields[2] !== group || fields[3] !== group || fs.statSync('/proc/' + pid).uid !== Number(uid)) process.exit(1);
  process.kill(-Number(group), signal);
} catch { process.exit(1); }
`;
export async function signalCheckGroup(group: CheckGroup, uid: number, gid: number, signal: NodeJS.Signals): Promise<boolean> {
  const members = await checkGroupMembers(group);
  if (!members.length || members.some(member => member.uid !== uid || member.session !== group.pid || BigInt(member.started) < BigInt(group.started)
    || (member.pid === group.pid && member.started !== group.started))) return false;
  const anchor = members.find(member => member.pid === group.pid && member.started === group.started);
  if (!anchor) return false;
  const child = spawn(process.execPath, ['-e', SIGNAL_GROUP, String(anchor.pid), anchor.started, String(group.pid), String(uid), signal], { uid, gid, env: {}, stdio: 'ignore' });
  const [code] = await once(child, 'exit') as [number | null];
  return code === 0;
}

type Cleanup = {
  list(group: CheckGroup): Promise<GroupProcess[]>;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  block(reason: string | null): void;
};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25));

/* The node owns the group even when its wrapper is gone. A stuck group keeps its slot and stops new admissions. The
   refusal clears by itself when the group disappears. Only process identity and controlled elapsed time matter. */
export async function cleanCheckGroup(group: CheckGroup, uid: number, cleanup: Cleanup): Promise<void> {
  const began = Date.now();
  let term = false, killed = false, blocked = false;
  try {
    for (;;) {
      const elapsed = Date.now() - began;
      let members: GroupProcess[] | null = null;
      try { members = await cleanup.list(group); } catch { /* An unreadable process table is not proof of cleanup. */ }
      if (members?.length === 0) return;
      const safe = members !== null && members.some(member => member.pid === group.pid && member.started === group.started) && members.every(member => member.uid === uid && member.session === group.pid && BigInt(member.started) >= BigInt(group.started))
        && !members.some(member => member.pid === group.pid && member.started !== group.started);
      if (safe) {
        const signal = !term ? 'SIGTERM' : !killed && (elapsed >= 5000 || members.every(member => member.pid === group.pid)) ? 'SIGKILL' : null;
        if (signal) {
          let sent = false;
          try { sent = await cleanup.kill(-group.pid, signal) !== false; } catch { /* Keep the slot and try cleanup again. */ }
          if (sent) {
            if (signal === 'SIGTERM') { term = true; continue; }
            killed = true;
          }
        }
      }
      if (elapsed >= 10000 && !blocked) {
        blocked = true;
        cleanup.block(`Check group ${group.pid} has not stopped. New checks wait until its processes are gone.`);
      }
      await pause();
    }
  } finally { if (blocked) cleanup.block(null); }
}
