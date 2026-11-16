import { existsSync } from 'node:fs';
import { lastWords } from './program-exit.js';
import { runProgram } from './providers/process.js';

/* Whether an agent program the node installed starts, which a file in place does not prove: npm may leave out a part, as
   it left out Claude Code's platform-native package on a node whose network broke off. The node asks the program its
   version, and one that does not answer with code 0 is installed again, a few times at most. */

export type Started = { ok: true } | { ok: false; code: number | null; line: string | null };
/* What the machine says of the program meanwhile: installed again, or still not starting and why; null once it starts. */
export type Repair = { state: 'reinstalling' } | { state: 'broken'; line: string | null } | null;

/* How many times a program that does not start is installed again, after the install that left it so. */
export const REINSTALLS = 2;
/* A program that does not even tell its version in this long does not start. */
const VERSION_LIMIT_MS = 30_000;

export async function startsCheck(bin: string): Promise<Started> {
  const done = await runProgram({ bin, args: ['--version'], env: { ...process.env }, timeoutMs: VERSION_LIMIT_MS });
  return done.code === 0 ? { ok: true } : { ok: false, code: done.code, line: lastWords(done.output) };
}

const notStarting = (check: Extract<Started, { ok: false }>) => new Error(check.line ?? `The program ended with code ${check.code ?? 'unknown'}.`);

/* One check for every program a node installs, by the path of its program file: an install at a time for each, and a
   program that started once in this process is not asked again until it is updated. */
export class CheckedInstalls {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly started = new Set<string>();
  /* Programs the machine was last told are being installed again or do not start. */
  private readonly troubled = new Set<string>();

  constructor(private readonly starts: (bin: string) => Promise<Started> = startsCheck) {}

  /* The first time something needs the program: installed when it is missing, then checked. */
  ensure(bin: string, install: () => Promise<void>, repair: (r: Repair) => void): Promise<void> {
    if (this.started.has(bin)) return Promise.resolve();
    return this.once(bin, async () => {
      if (!existsSync(bin)) await install();
      await this.untilStarts(bin, install, repair);
    });
  }

  /* An update: installed anew, then checked the same way. */
  update(bin: string, install: () => Promise<void>, repair: (r: Repair) => void): Promise<void> {
    return this.once(bin, async () => {
      this.started.delete(bin);
      await install();
      await this.untilStarts(bin, install, repair);
    });
  }

  private once(bin: string, work: () => Promise<void>): Promise<void> {
    let pending = this.pending.get(bin);
    if (!pending) {
      pending = work().finally(() => this.pending.delete(bin));
      this.pending.set(bin, pending);
    }
    return pending;
  }

  private async untilStarts(bin: string, install: () => Promise<void>, say: (r: Repair) => void): Promise<void> {
    const repair = (r: Repair) => {
      if (r) this.troubled.add(bin);
      else if (!this.troubled.delete(bin)) return;
      say(r);
    };
    let check = await this.starts(bin);
    for (let n = 0; !check.ok && n < REINSTALLS; n++) {
      repair({ state: 'reinstalling' });
      try {
        await install();
      } catch (err) {
        repair({ state: 'broken', line: null });
        throw err;
      }
      check = await this.starts(bin);
    }
    if (!check.ok) {
      repair({ state: 'broken', line: check.line });
      throw notStarting(check);
    }
    repair(null);
    this.started.add(bin);
  }
}
