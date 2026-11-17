import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/* Why the node cannot write its work folder now, or null when a small file there is written, flushed and removed. Every
   turn works in that folder, so a node that cannot write it can take none. */
export async function workFolderError(dir: string): Promise<string | null> {
  const work = join(dir, 'work');
  const file = join(work, `.hh-write-check-${process.pid}`);
  try {
    mkdirSync(work, { recursive: true });
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, 'ok');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rmSync(file, { force: true });
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  }
}
