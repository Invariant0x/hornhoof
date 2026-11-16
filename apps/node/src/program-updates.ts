import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProgramInfo } from '@hornhoof/protocol';
import type { Repair } from './program-check.js';
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

/* A program's state without what an earlier check said of it. */
const plain = ({ id, version, updating, failed }: ProgramInfo): ProgramInfo => ({ id, version, updating, failed });

/* One installation at a time in a node's shared npm prefix. Running agent processes are never signalled. */
export class ProgramUpdates {
  private state: ProgramInfo[];
  private pending: Promise<void> | null = null;
  private told: () => void = () => {};

  constructor(private readonly entries: readonly InstalledProgram[]) {
    this.state = entries.map(entry => ({ id: entry.id, version: entry.readVersion(), updating: false, failed: false }));
  }

  snapshot(): ProgramInfo[] {
    return this.state.map(program => ({ ...program }));
  }

  version(id: string): string | null {
    return this.state.find(program => program.id === id)?.version ?? null;
  }

  /* Who hears of a program installed again or not starting, which happens outside an update too. */
  watch(changed: () => void): void {
    this.told = changed;
  }

  /* What the machine says of a program that did not start; a program this node does not manage is left out. */
  repaired(id: string, repair: Repair): void {
    if (!this.state.some(program => program.id === id)) return;
    this.state = this.state.map(program => program.id === id ? { ...plain(program), ...(repair ? { repair: repair.state } : {}), ...(repair?.state === 'broken' && repair.line ? { reason: repair.line } : {}) } : program);
    this.told();
  }

  ready(signal?: AbortSignal): Promise<void> {
    const pending = this.pending ?? Promise.resolve();
    return signal ? untilReady(pending, signal) : pending;
  }

  /* Why an installation failed goes only to log, the machine's own output, never into what Hornhoof is told. */
  update(changed: () => void = () => {}, log: (line: string) => void = () => {}): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.entries.length) return Promise.resolve();
    this.state = this.state.map(program => ({ ...plain(program), updating: true, failed: false }));
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
      /* What its check said during this install stays. */
      this.state = this.state.map(program => program.id === entry.id ? { ...program, version, updating: false, failed } : program);
      changed();
    }
  }
}
