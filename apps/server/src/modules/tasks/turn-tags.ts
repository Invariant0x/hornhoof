/* Version tags of a repository: vX.Y.Z, compared by their numbers. */

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;

function versionOf(name: string): [number, number, number] | null {
  const found = VERSION.exec(name);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

export function newerVersion(a: string, b: string): boolean {
  const x = versionOf(a), y = versionOf(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/* The version tags among a repository's tags, the newest first, each with the commit it is on. */
export const versionsNewestFirst = (tags: Record<string, string>): [string, string][] =>
  Object.entries(tags).filter(([name]) => versionOf(name)).sort(([a], [b]) => newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0);
