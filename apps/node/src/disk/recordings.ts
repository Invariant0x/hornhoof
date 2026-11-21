import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { folderBytes, type Cleaner } from './clean.js';

/* How long a recording no register names stays before it goes: the node writes a recording's name into its register before
   any of its files, and takes it out only after them, so one with no name a day on is what a stopped node left. */
export const RECORDING_LEFTOVER_MS = 24 * 3600_000;

const SOCKET = /^[a-f0-9]{64}$/;
const ENTRY_MAX = 4096;
const REGISTER = /^[a-f0-9]{64}\.json$/;
/* A recording's output and the three small files beside it; the screen a pane shows once its program is over, and the
   settings a program starts with, which each go the moment they are read. */
const LEFTOVER = /^(\.hh-output-[a-f0-9]{16}\.log)(\.ready|\.flush|\.position)?$|^\.hh-(screen|env)-[a-f0-9]{16}$/;

/* The outputs the register of one socket names, or null when one entry of it cannot be read, and then all of it stays. */
async function named(folder: string, names: string[]): Promise<Set<string> | null> {
  const outputs = new Set<string>();
  for (const name of names.filter(n => REGISTER.test(n))) {
    try {
      const st = await lstat(join(folder, name));
      if (!st.isFile() || st.size > ENTRY_MAX) return null;
      const entry: unknown = JSON.parse(await readFile(join(folder, name), 'utf8'));
      const file = (entry as { file?: unknown } | null)?.file;
      if (typeof file !== 'string') return null;
      outputs.add(basename(file));
    } catch {
      return null;
    }
  }
  return outputs;
}

/* The recordings of the node's terminals, in its own folder .hh-recordings, one folder per terminal socket. The recorder keeps
   each to its last output and the node removes a session's recording when the session ends and all of them when it starts,
   so what is left is what a node stopped in the middle of that left: files no register names, a day on. A file of another
   name, a link and the register itself stay. */
export function recordings(dir: string, now: () => number = Date.now): Cleaner {
  const root = join(dir, '.hh-recordings');
  return {
    part: 'recordings',
    size: () => folderBytes(root),
    async clean() {
      let freed = 0;
      for (const socket of await readdir(root).catch(() => [] as string[])) {
        const folder = join(root, socket);
        if (!SOCKET.test(socket) || !(await lstat(folder).catch(() => null))?.isDirectory()) continue;
        const names = await readdir(folder).catch(() => [] as string[]);
        const kept = await named(folder, names);
        if (!kept) continue;
        for (const name of names) {
          const match = LEFTOVER.exec(name);
          if (!match || (match[1] && kept.has(match[1]))) continue;
          const file = join(folder, name);
          const st = await lstat(file).catch(() => null);
          if (!st?.isFile() || now() - st.mtimeMs < RECORDING_LEFTOVER_MS) continue;
          await rm(file, { force: true });
          freed += st.blocks * 512;
        }
      }
      return freed;
    },
  };
}
