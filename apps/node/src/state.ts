import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_IDS, type ProviderId } from '@hornhoof/protocol';
import { z } from 'zod';

/* What the installer wrote: where Hornhoof is, which subscription this node serves and its key. */
export type NodeState = { server: string; subscriptionId: string; provider: ProviderId; key: string };

const State = z.object({ server: z.string().url(), subscriptionId: z.string().min(1), provider: z.enum(PROVIDER_IDS), key: z.string().min(16) });

export const dataDir = (): string => process.env.HORNHOOF_DATA || '/data';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writePrivate(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readState(dir: string): NodeState | null {
  const parsed = State.safeParse(readJson(join(dir, 'node.json')));
  return parsed.success ? parsed.data : null;
}

export function writeState(dir: string, state: NodeState): void {
  writePrivate(join(dir, 'node.json'), State.parse(state));
}

/* After Hornhoof removes the subscription the node keeps the container alive but does nothing. */
export function markRemoved(dir: string): void {
  writeFileSync(join(dir, 'removed'), new Date().toISOString() + '\n');
}

export const isRemoved = (dir: string): boolean => existsSync(join(dir, 'removed'));

/* Which work folder each agent session lives in, so a resumed session sees its own files. */
export function readSessions(dir: string): Record<string, string> {
  const data = readJson(join(dir, 'sessions.json'));
  return data && typeof data === 'object' ? (data as Record<string, string>) : {};
}

export function rememberSession(dir: string, sessionId: string, workDir: string): void {
  writePrivate(join(dir, 'sessions.json'), { ...readSessions(dir), [sessionId]: workDir });
}
