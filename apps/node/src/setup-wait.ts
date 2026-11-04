import type { ProviderAdapter } from './runner.js';

/* Whether the plan's signed-in program waits for a first setup only the plan's owner may pass, such as agy's terms. The
   plan's turns wait for it as for a sign-in, and the node says so in its hello and status. */
export class SetupWait {
  needed = false;

  constructor(private readonly program: Pick<ProviderAdapter, 'setupNeeded'> | null) {}

  /* Reads it again; a program that is not signed in waits for its sign-in first. True when it changed. */
  async check(loggedIn: boolean): Promise<boolean> {
    const was = this.needed;
    this.needed = loggedIn && Boolean(await this.program?.setupNeeded?.().catch(() => false));
    return this.needed !== was;
  }

  /* While signed out or waiting for the setup: whether the program is signed in now, and whether either changed. */
  async recheck(loggedIn: boolean, signedIn: () => Promise<boolean>): Promise<{ loggedIn: boolean; changed: boolean }> {
    if (loggedIn && !this.needed) return { loggedIn, changed: false };
    const now = loggedIn || (await signedIn());
    const changed = await this.check(now);
    return { loggedIn: now, changed: changed || now !== loggedIn };
  }

  /* A turn that ended on the setup. True when it did. */
  met(failure: { kind: string } | null | undefined): boolean {
    if (failure?.kind !== 'setup') return false;
    this.needed = true;
    return true;
  }

  /* What the node's hello and status say of it. */
  field(): { setupNeeded?: true } {
    return this.needed ? { setupNeeded: true } : {};
  }
}
