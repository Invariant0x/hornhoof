import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* The folders the test helpers keep in the machine's temporary folder. A run removes its own as it ends, however it ends
   short of being killed outright; a folder that is left has its owner in it, so the node of the machine can tell it from the
   folder of a run that is alive, and takes it away. */

/* "PID START": this process, and the kernel's start time of it, which tells it from a later process with the same number. */
export const OWNER_FILE = '.hh-owner';

const made = new Set<string>();
let hooked = false;

function owner(): string {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (start && /^\d+$/.test(start)) return `${process.pid} ${start}`;
  } catch { /* A machine with no /proc names the pid alone. */ }
  return String(process.pid);
}

function keep(dir: string): string {
  made.add(dir);
  if (!hooked) { hooked = true; process.on('exit', removeTempFolders); }
  try { writeFileSync(join(dir, OWNER_FILE), owner()); } catch (error) { removeTempFolder(dir); throw error; }
  return dir;
}

export function tempFolderSync(prefix: string): string {
  return keep(mkdtempSync(join(tmpdir(), prefix)));
}

export async function tempFolder(prefix: string): Promise<string> {
  return keep(await mkdtemp(join(tmpdir(), prefix)));
}

export function removeTempFolder(dir: string): void {
  made.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/* Every folder made and not removed yet, which is what a process leaves as it ends. */
export function removeTempFolders(): void {
  for (const dir of [...made]) removeTempFolder(dir);
}
