import type { EnvironmentSnapshot } from '@hornhoof/protocol';

/* What a product run stands for. With no one suite asked for, the profile a turn ends with, or the full run that replaces it, runs
   the whole product: every file that did not keep a green result at its fingerprint. Anything else is a look at what a change
   reaches. */
export function runPurpose(snapshot: EnvironmentSnapshot, suite: string | undefined): 'final' | 'affected' {
  if (suite || snapshot.candidate) return 'affected';
  return snapshot.profile === 'final' || snapshot.profile === snapshot.description.manifest.execution?.fullRun?.profile ? 'final' : 'affected';
}
