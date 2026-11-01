import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { JobUser } from './isolation.js';

/* What the node does in an agent's home and work folder: they belong to the agents, who can put a link anywhere in them. */
export type AgentFs = {
  mkdir(path: string): Promise<void>;
  /* The file's text, or null when there is none. */
  read(path: string): Promise<string | null>;
  /* Replaces the file whole, readable by the agents' user only. */
  write(path: string, data: string): Promise<void>;
  /* Takes away a file or a folder whole; a link goes, not what it points at. */
  remove(path: string): Promise<void>;
  /* Copies a folder of the node's own, such as one from the image, with its files' modes. */
  copy(from: string, to: string): Promise<void>;
  stop(): void;
};

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
    write: async (path, data) => void (await ask('write', path, { data })),
    remove: async path => void (await ask('remove', path)),
    copy: async (from, to) => void (await ask('copy', to, { from })),
    stop() {
      child?.kill();
      child = null;
    },
  };
}
