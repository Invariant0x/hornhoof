import type { NodeMessage } from '@hornhoof/protocol';
import type { CalledOff } from './terminal/host.js';

type JobDone = Extract<NodeMessage, { type: 'job.done' }>;
/* A job the node runs: the way to call it off, and the session Hornhoof gave it. */
export type HeldJob = { stop: AbortController; sessionId: string | null };
/* The terminal host's part in a Stop. */
export type StopsHost = { calledOffEnd(jobId: string): CalledOff | null; cancel(jobId: string): Promise<void> };
export type StopsPorts = {
  held(jobId: string): HeldJob | undefined;
  outside(jobId: string): void;
  host(): StopsHost | null;
  emit(end: JobDone): void;
  hold(end: JobDone): void;
};

/* Hornhoof calls a job off: its program stops as on Escape, and a job this node runs ends as stopped at once, though its
   run may still wait for the program to say the turn ended. That end is told once: the run's own end when it comes, a
   Stop again and a Stop for a job the node does not hold tell nothing. A turn a person typed tells its end itself. */
export class Stops {
  /* Jobs whose end a Stop told: when their run ends after all, that end is not told again. */
  private readonly told = new Set<string>();

  constructor(private readonly ports: StopsPorts) {}

  async callOff(jobId: string): Promise<void> {
    const held = this.ports.held(jobId);
    held?.stop.abort();
    this.ports.outside(jobId);
    if (held) this.tell(jobId, held.sessionId);
    await this.ports.host()?.cancel(jobId);
  }

  /* A job's end from the moment it leaves running, unless a Stop told it already. */
  ended(done: JobDone): void {
    if (!this.told.delete(done.jobId)) this.ports.hold(done);
  }

  /* With the session and tokens of its turn when the host has them, else with the session the job was given. */
  private tell(jobId: string, sessionId: string | null): void {
    if (this.told.has(jobId)) return;
    this.told.add(jobId);
    const end = this.ports.host()?.calledOffEnd(jobId);
    this.ports.emit({ type: 'job.done', jobId, ok: false, sessionId: end?.sessionId ?? sessionId, result: 'Stopped.', tail: '', error: 'cancelled', ...(end ? { tokens: end.tokens } : {}) });
  }
}
