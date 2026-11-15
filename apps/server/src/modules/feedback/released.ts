import { compareVersions } from '../updates/registry.js';

/* What the releases of Hornhoof say about the reports installations sent: each by its number in the inbox of Hornhoof's
   developers, with the issue it became and the version that fixed it, once there is one. Whoever prepares a release adds
   the reports it fixes, read off that inbox. A new version brings this list with it, so an installation learns the fate of
   what it sent when it updates, with no service to ask and no timer. */
export type Released = { report: number; issue: { number: number; url: string } | null; fixedIn: string | null };

export const RELEASED: readonly Released[] = [];

const SEMVER = /^\d+\.\d+\.\d+$/;
/* Whether the running version is the fixing one or newer. A version written otherwise, as in a build of a branch, is not. */
const reaches = (version: string, fixedIn: string) => SEMVER.test(version) && SEMVER.test(fixedIn) && compareVersions(fixedIn, version) >= 0;

/* What the running version knows of a report: its issue, and the version that fixed it if that is this one or older. */
export function fateOf(released: readonly Released[], version: string, report: number | null): { issue: Released['issue']; fixedIn: string | null } {
  const found = report === null ? undefined : released.find(r => r.report === report);
  const fixedIn = found?.fixedIn && reaches(version, found.fixedIn) ? found.fixedIn : null;
  return { issue: found?.issue ?? null, fixedIn };
}
