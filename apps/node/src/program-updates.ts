import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProgramInfo } from '@hornhoof/protocol';
import { NPM_PACKAGES } from './providers/packages.js';

type ProgramId = ProgramInfo['id'];
type InstalledProgram = { id: ProgramId; install(): Promise<void>; readVersion(): string | null };
const VersionMetadata = ProgramInfo.pick({ version: true });

export function readInstalledVersion(tools: string, id: ProgramId): string | null {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(tools, 'lib', 'node_modules', NPM_PACKAGES[id], 'package.json'), 'utf8'));
    return VersionMetadata.parse(metadata).version;
  } catch {
    return null;
  }
}

/* Cancelling one waiting turn leaves the node's shared installation running. */
async function untilReady(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let abort!: () => void;
  const stopped = new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); });
  try {
    await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/* One installation at a time in a node's shared npm prefix. Running agent processes are never signalled. */
export class ProgramUpdates {
  private state: ProgramInfo[];
  private pending: Promise<void> | null = null;

  constructor(private readonly entries: readonly InstalledProgram[]) {
    this.state = entries.map(entry => ({ id: entry.id, version: entry.readVersion(), updating: false, failed: false }));
  }

  snapshot(): ProgramInfo[] {
    return this.state.map(program => ({ ...program }));
  }

  version(id: string): string | null {
    return this.state.find(program => program.id === id)?.version ?? null;
  }

  ready(signal?: AbortSignal): Promise<void> {
    const pending = this.pending ?? Promise.resolve();
    return signal ? untilReady(pending, signal) : pending;
  }

  /* Why an installation failed goes only to log, the node's own log that hides secrets, never into what Hornhoof is told. */
  update(changed: () => void = () => {}, log: (line: string) => void = () => {}): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.entries.length) return Promise.resolve();
    this.state = this.state.map(program => ({ ...program, updating: true, failed: false }));
    this.pending = Promise.resolve().then(() => this.installAll(changed, log)).finally(() => { this.pending = null; });
    changed();
    return this.pending;
  }

  private async installAll(changed: () => void, log: (line: string) => void): Promise<void> {
    for (const entry of this.entries) {
      let failed = false;
      try {
        await entry.install();
      } catch (err) {
        failed = true;
        log(`Could not update ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const version = entry.readVersion();
      this.state = this.state.map(program => program.id === entry.id ? { id: entry.id, version, updating: false, failed } : program);
      changed();
    }
  }
}
