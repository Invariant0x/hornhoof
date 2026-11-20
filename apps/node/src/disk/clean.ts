import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiskPart, DiskReport } from '@hornhoof/protocol';

/* What a cleaning leaves because it cannot come back, as the disk report names it, without its part. */
export type Stay = Omit<NonNullable<DiskReport['kept']>[number], 'part'>;

/* One part of Hornhoof's share of a disk: what it takes now, and the cleaning that removes what of it can come back. clean
   says how many bytes it freed; kept, where a part has it, what its last cleaning left because it cannot come back. */
export type Cleaner = { part: DiskPart; size(): Promise<number>; clean(): Promise<number>; kept?(): Stay[] };

/* What a folder takes on its disk, in bytes, as du counts it: the blocks of its files, on that disk alone, never following
   a link. A folder that is not there takes nothing. du runs apart, so a folder of a million files never holds the node up. */
export function folderBytes(path: string): Promise<number> {
  return new Promise(resolve => {
    execFile('du', ['-skx', '--', path], { encoding: 'utf8', maxBuffer: 1 << 20 }, (_err, stdout) => {
      const kib = /^(\d+)\s/.exec(stdout)?.[1];
      resolve(kib ? Number(kib) * 1024 : 0);
    });
  });
}

/* The temporary files of checks: the node's folder of runs, where each part, harness and author check works. One part runs
   on a node at a time and the node empties the folder when it starts, so while no check runs all that is in it is left over.
   While one runs, nothing in it goes. A link in it goes, never what it points to. */
export function checkTemp(dir: string, checking: () => boolean): Cleaner {
  const runs = join(dir, 'runs');
  return {
    part: 'checkTemp',
    size: () => folderBytes(runs),
    async clean() {
      if (checking()) return 0;
      const before = await folderBytes(runs);
      const names = await readdir(runs).catch(() => [] as string[]);
      for (const name of names) {
        if (checking()) break;
        await rm(join(runs, name), { recursive: true, force: true });
      }
      return Math.max(0, before - (await folderBytes(runs)));
    },
  };
}
