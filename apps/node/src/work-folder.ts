import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/* A new file or nothing: never through a link, never over anything already there. */
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/* The folder the node holds open, as a path that stays in it when its name is moved or swapped for a link. Only Linux has
   one; elsewhere the node goes by the name, and there it never runs as root over its agents (agentUser reads /proc). */
const heldPath = (fd: number, name: string) => (existsSync(`/proc/self/fd/${fd}`) ? `/proc/self/fd/${fd}` : name);

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/* Why the node cannot write its work folder now, or null when a small file there is written, flushed and removed. Every
   turn works in that folder, so a node that cannot write it can take none. The folder is the agents', who can put a link
   anywhere in it, and a node that runs as root writes there: so the folder is opened as it stands, not through a link, the
   file gets a name nobody can guess and is made new in that open folder, and a link or anything else at its name stops
   the check rather than being written through. */
export async function workFolderError(dir: string): Promise<string | null> {
  const work = join(dir, 'work');
  try {
    mkdirSync(work, { recursive: true });
    let folder: number;
    try {
      folder = openSync(work, FOLDER);
    } catch (err) {
      if (isLink(work)) return `${work} is a link, not a folder, so the node writes nothing through it.`;
      throw err;
    }
    try {
      const file = join(heldPath(folder, work), `.hh-write-check-${randomUUID()}`);
      const fd = openSync(file, NEW_FILE, 0o600);
      try {
        writeSync(fd, 'ok');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      /* Takes away the name only: whatever an agent put there since goes, not what a link points at. */
      rmSync(file, { force: true });
    } finally {
      closeSync(folder);
    }
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  }
}
