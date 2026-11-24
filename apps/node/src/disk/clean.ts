import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskPart, DiskReport } from '@hornhoof/protocol';
import type { Leftovers } from './leftovers.js';

/* What a cleaning leaves because it cannot come back, as the disk report names it, without its part. */
export type Stay = Omit<NonNullable<DiskReport['kept']>[number], 'part'>;

/* One part of Hornhoof's share of a disk: what it takes now, and the cleaning that removes what of it can come back. clean
   says how many bytes it freed; quick, where a part has it, the part of that cleaning that takes a moment and may run while a
   check waits; kept, where a part has it, what its last cleaning left because it cannot come back. */
export type Cleaner = { part: DiskPart; size(): Promise<number>; clean(): Promise<number>; quick?(): Promise<number>; kept?(): Stay[] };

/* How long du may count one folder before the node gives up on it. */
export const DU_TIMEOUT_MS = 5 * 60_000;

/* What a folder takes on its disk, in bytes, as du counts it: the blocks of its files, on that disk alone, never following
   a link. A folder that is not there takes nothing. du runs apart, so a folder of a million files never holds the node up,
   and one that does not finish in time fails, so the part stays unmeasured and the next pass still comes. */
export function folderBytes(path: string, timeoutMs = DU_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('du', ['-skx', '--', path], { encoding: 'utf8', maxBuffer: 1 << 20, timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout) => {
      if (err?.killed) {
        reject(new Error(`du did not finish in ${Math.ceil(timeoutMs / 1000)} s`));
        return;
      }
      const kib = /^(\d+)\s/.exec(stdout)?.[1];
      resolve(kib ? Number(kib) * 1024 : 0);
    });
  });
}

/* The temporary files of checks: the node's folder of runs, where each part, harness and author check works, and the folders
   the test helpers leave in the machine's temporary folder. One part runs on a node at a time and the node empties the folder
   of runs when it starts, so while no check runs all that is in it is left over. While one runs, nothing in it goes. A link in
   it goes, never what it points to. What the helpers left goes when nothing owns or holds it, run or no run. */
export function checkTemp(dir: string, checking: () => boolean, tests?: Leftovers): Cleaner {
  const runs = join(dir, 'runs');
  return {
    part: 'checkTemp',
    size: async () => (await folderBytes(runs)) + (tests ? await tests.size() : 0),
    quick: async () => (tests ? tests.clean() : 0),
    async clean() {
      const left = tests ? await tests.clean() : 0;
      if (checking()) return left;
      const before = await folderBytes(runs);
      const names = await readdir(runs).catch(() => [] as string[]);
      for (const name of names) {
        if (checking()) break;
        await rm(join(runs, name), { recursive: true, force: true });
      }
      return left + Math.max(0, before - (await folderBytes(runs)));
    },
  };
}
