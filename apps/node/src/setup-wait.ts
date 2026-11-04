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

  /* While signed out or waiting for the setup: whether it found the program signed in by looking again, and whether either
     changed. */
  async recheck(loggedIn: boolean, signedIn: () => Promise<boolean>): Promise<{ signedIn: boolean; changed: boolean }> {
    if (loggedIn && !this.needed) return { signedIn: false, changed: false };
    const found = !loggedIn && (await signedIn());
    const changed = await this.check(loggedIn || found);
    return { signedIn: found, changed: changed || found };
  }

  /* A turn that ended on the setup. */
  met(failure: { kind: string } | null | undefined): void {
    if (failure?.kind === 'setup') this.needed = true;
  }

  /* What the node's hello and status say of it. */
  field(): { setupNeeded?: true } {
    return this.needed ? { setupNeeded: true } : {};
  }
}
