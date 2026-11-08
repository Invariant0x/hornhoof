import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { closeSync, constants, cpSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { JobUser } from './isolation.js';

/* What the node does in an agent's home and work folder: they belong to the agents, who can put a link anywhere in them. */
export type AgentFs = {
  mkdir(path: string): Promise<void>;
  /* The file's text, or null when there is none. */
  read(path: string): Promise<string | null>;
  /* What is at the path as the agents' user sees it, links followed: a file, a folder, or nothing it can reach. */
  kind(path: string): Promise<'file' | 'dir' | null>;
  /* What stands at the path itself, a link not followed: a plain file, a folder, a link, anything else, or nothing. */
  entry(path: string): Promise<Entry | null>;
  /* The text of a plain file at the path itself, or null when there is none. Never through a link, and never waiting on a pipe
     or a device: anything else there fails at once. */
  readPlain(path: string): Promise<string | null>;
  /* Replaces the file whole, readable by the agents' user only. */
  write(path: string, data: string): Promise<void>;
  /* Takes away a file or a folder whole; a link goes, not what it points at. */
  remove(path: string): Promise<void>;
  /* Copies a folder of the node's own, such as one from the image, with its files' modes. */
  copy(from: string, to: string): Promise<void>;
  /* Moves a file or a folder whole, its links as they are, and never over anything already there, a link included. */
  move(from: string, to: string): Promise<void>;
  stop(): void;
};

export type Entry = 'file' | 'dir' | 'link' | 'other';

function entryAt(path: string): Entry | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
}

function plainText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${path} is a link, not a plain file.`);
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a plain file.`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/* What already stands at a path, a link that leads nowhere too, keeps it from being moved over. A file or a link gets its
   new name in one step that fails when the name is taken; a folder can only ever be moved over an empty folder. */
function moveInto(from: string, to: string): void {
  const taken = () => new Error(`${to} is there already, so nothing was moved over it.`);
  try {
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      if (entryAt(to)) throw taken();
      renameSync(from, to);
      return;
    }
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else linkSync(from, to);
  } catch (err) {
    if (['EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw taken();
    throw err;
  }
  unlinkSync(from);
}

const HELPER = fileURLToPath(new URL('../hh-fs.cjs', import.meta.url));

/* A node that runs as the agents' own user does the work itself. */
export const ownFs: AgentFs = {
  async mkdir(path) {
    mkdirSync(path, { recursive: true });
  },
  async read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async kind(path) {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  async entry(path) {
    return entryAt(path);
  },
  async readPlain(path) {
    return plainText(path);
  },
  async write(path, data) {
    const temp = `${path}.hh-${process.pid}`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  },
  async remove(path) {
    rmSync(path, { recursive: true, force: true });
  },
  async copy(from, to) {
    cpSync(from, to, { recursive: true });
  },
  async move(from, to) {
    moveInto(from, to);
  },
  stop() {},
};

type Pending = { resolve(data: unknown): void; reject(err: Error): void };

/* A node that runs as root asks one long-lived helper of the agents' user, started again if it ends. */
export function agentFs(user: JobUser): AgentFs {
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let next = 0;
  const pending = new Map<number, Pending>();

  const helper = () => {
    if (child) return child;
    const started = spawn(process.execPath, [HELPER], { uid: user.uid, gid: user.gid, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'] });
    child = started;
    createInterface({ input: started.stdout }).on('line', line => {
      let reply: { id?: number; ok?: boolean; data?: unknown; error?: string };
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = typeof reply.id === 'number' ? pending.get(reply.id) : undefined;
      if (!waiting) return;
      pending.delete(reply.id!);
      if (reply.ok) waiting.resolve(reply.data);
      else waiting.reject(new Error(reply.error ?? 'The file helper failed.'));
    });
    const gone = () => {
      if (child === started) child = null;
      for (const [id, waiting] of pending) {
        pending.delete(id);
        waiting.reject(new Error('The file helper ended.'));
      }
    };
    started.on('exit', gone);
    started.on('error', gone);
    return started;
  };

  const ask = (op: string, path: string, more: Record<string, string> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      helper().stdin.write(JSON.stringify({ id, op, path, ...more }) + '\n');
    });

  return {
    mkdir: async path => void (await ask('mkdir', path)),
    read: async path => {
      const data = await ask('read', path);
      return typeof data === 'string' ? data : null;
    },
    kind: async path => {
      const data = await ask('kind', path);
      return data === 'file' || data === 'dir' ? data : null;
    },
    entry: async path => {
      const data = await ask('entry', path);
      return data === 'file' || data === 'dir' || data === 'link' || data === 'other' ? data : null;
    },
    readPlain: async path => {
      const data = await ask('readPlain', path);
      return typeof data === 'string' ? data : null;
    },
    write: async (path, data) => void (await ask('write', path, { data })),
    remove: async path => void (await ask('remove', path)),
    copy: async (from, to) => void (await ask('copy', to, { from })),
    move: async (from, to) => void (await ask('move', to, { from })),
    stop() {
      child?.kill();
      child = null;
    },
  };
}
