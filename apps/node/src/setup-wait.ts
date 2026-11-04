import type { ProviderAdapter } from './runner.js';

/* How often the node looks again at a first setup the plan waits for. For agy that means starting it to see its screen. */
export const SETUP_CHECK_MS = 60_000;

/* Whether the plan's signed-in program waits for a first setup only the plan's owner may pass, such as agy's terms. The
   plan's turns wait for it as for a sign-in, and the node says so in its hello and status. */
export class SetupWait {
  needed = false;
  private lookedAt = -Infinity;
  private looking = false;
  private look: Promise<boolean> | null = null;

  constructor(
    private readonly program: Pick<ProviderAdapter, 'setupNeeded'> | null,
    private readonly everyMs = SETUP_CHECK_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /* Asks the program again; a program that is not signed in waits for its sign-in first. True when it changed. */
  async check(loggedIn: boolean): Promise<boolean> {
    const was = this.needed;
    this.lookedAt = this.now();
    this.needed = loggedIn && (await this.lookOnce());
    return this.needed !== was;
  }

  /* One look at a time: one that starts agy can outlast the ticks and sign-ins that ask meanwhile, which take its answer. */
  private lookOnce(): Promise<boolean> {
    this.look ??= (async () => Boolean(await this.program?.setupNeeded?.()))().catch(() => false).finally(() => (this.look = null));
    return this.look;
  }

  /* While signed out, or now and then while waiting for the setup: whether it found the program signed in by looking
     again, and whether either changed. One look at a time: a look that starts agy can outlast the ticks that ask. */
  async recheck(loggedIn: boolean, signedIn: () => Promise<boolean>): Promise<{ signedIn: boolean; changed: boolean }> {
    if (this.looking || (loggedIn && (!this.needed || this.now() - this.lookedAt < this.everyMs))) return { signedIn: false, changed: false };
    this.looking = true;
    try {
      const found = !loggedIn && (await signedIn());
      const changed = await this.check(loggedIn || found);
      return { signedIn: found, changed: changed || found };
    } finally {
      this.looking = false;
    }
  }

  /* A turn that ended on the setup, which saw it as a look would. */
  met(failure: { kind: string } | null | undefined): void {
    if (failure?.kind !== 'setup') return;
    this.needed = true;
    this.lookedAt = this.now();
  }

  /* What the node's hello and status say of it. */
  field(): { setupNeeded?: true } {
    return this.needed ? { setupNeeded: true } : {};
  }
}
