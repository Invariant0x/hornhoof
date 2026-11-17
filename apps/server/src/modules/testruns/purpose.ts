import type { EnvironmentSnapshot, TestEnvironmentV1 } from '@hornhoof/protocol';

/* What a product run stands for. With no one suite asked for, the profile of the full run, or a profile named final, runs the whole
   product: every file that did not keep a green result of its release. Anything else is a look at part of it. */
export function runPurpose(snapshot: EnvironmentSnapshot, suite: string | undefined): 'final' | 'affected' {
  if (suite) return 'affected';
  return snapshot.profile === 'final' || snapshot.profile === snapshot.description.manifest.execution?.fullRun?.profile ? 'final' : 'affected';
}

/* What a product run left out of the whole product: the suites its profile or its one suite does not run, and how many test files
   kept a green result of an earlier run instead of running. A run that left out nothing ran every suite and every test file anew,
   as the first run of a release does. */
export type RunScope = { profile: string; leftOut: string[]; kept: number };
/* What of a run's snapshot that takes: its profile and its manifest, without the inventory and fingerprints. */
export type ScopeSource = { profile: string; manifest: Pick<TestEnvironmentV1, 'profiles' | 'suites' | 'execution'> };
export const scopeSource = (snapshot: EnvironmentSnapshot): ScopeSource => ({ profile: snapshot.profile, manifest: snapshot.description.manifest });
export function runScope({ profile, manifest }: ScopeSource, suite: string | null | undefined, kept: number): RunScope {
  const ran = suite ? [suite] : manifest.profiles.find(item => item.id === profile)?.requiredSuiteIds ?? [];
  return { profile, leftOut: manifest.suites.map(item => item.id).filter(id => !ran.includes(id)), kept };
}
const ranEverything = (scope: RunScope): boolean => !scope.leftOut.length && !scope.kept;

const listed = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
/* The same in words, after "with profile ...". */
export function scopeWords(scope: RunScope): string {
  if (ranEverything(scope)) return ': every suite and every test file ran anew.';
  const what = [
    ...(scope.leftOut.length ? [`left out the suites ${listed(scope.leftOut)}`] : []),
    ...(scope.kept ? [`took the green result of an earlier run of its release for ${scope.kept} test ${scope.kept === 1 ? 'file' : 'files'} instead of running ${scope.kept === 1 ? 'it' : 'them'}`] : []),
  ];
  return `, which ${what[0]}${what.slice(1).map(part => `, and ${part}`).join('')}.`;
}
