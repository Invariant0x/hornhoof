/* Whether a commit changes only what a release adds over a commit whose tests passed: the versions `npm run release:version`
   writes into the package.json files and package-lock.json, and the notes in CHANGELOG.md. The tests that passed on its
   parent then pass on it as well, but for the release check, which reads exactly those files.

   It reads only what it is given, so it is tested whole without git: changes lists each changed path with the status
   letter git gives it, and read(path) gives a modified file's text at the parent and at the commit. Each JSON file is read
   both as JSON and line by line, so that only its "version" values change and its form stays as it was. */

const NOTES = 'CHANGELOG.md';
const LOCK = 'package-lock.json';
const MANIFEST = /(?:^|\/)package\.json$/;
/* A line holding one version, as npm and release:version write it: the indentation, the value and the comma after it. */
const VERSION_LINE = /^( *)"version": "[^"\\]*"(,?)$/;
const KINDS = { A: 'added', D: 'deleted' };

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withoutVersion = object => Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'version'));
/* A package of the repository itself, the root as '' among them, rather than one installed under node_modules. */
const isOwnPackage = folder => !folder.split('/').includes('node_modules');
const folderOf = manifest => manifest.slice(0, -'package.json'.length).replace(/\/$/, '');
const isReleaseFile = path => path === NOTES || path === LOCK || MANIFEST.test(path);

function objectOf(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/* The indentation and comma of a version line; undefined for any other line. */
const versionLineForm = line => VERSION_LINE.exec(line)?.slice(1).join('');

function onlyVersionLines(before, after) {
  const was = before.split('\n'), now = after.split('\n');
  return was.length === now.length && was.every((line, at) => line === now[at] || (versionLineForm(line) !== undefined && versionLineForm(line) === versionLineForm(now[at])));
}

/* A path that is no plain change of a release file, named with what git did to it. */
function otherPath(changes) {
  const other = changes.find(({ status, path }) => status !== 'M' || !isReleaseFile(path));
  if (!other) return null;
  if (other.status !== 'M') return `${other.path} is ${KINDS[other.status] ?? 'turned into another kind of file'}`;
  return `${other.path} is neither a version nor the release notes`;
}

/* A package.json whose version alone changes, and package-lock.json gives its package that same version. */
function manifestProblem({ path, before, after }, lock) {
  if (!before || !after) return `${path} is not a JSON object`;
  if (!same(withoutVersion(before), withoutVersion(after))) return `${path} changes more than its version`;
  if (!lock) return `${path} changes its version without ${LOCK}`;
  const folder = folderOf(path), entry = lock.after?.packages?.[folder];
  if (!isOwnPackage(folder) || !isObject(entry)) return `${path} is no package of the repository in ${LOCK}`;
  if (entry.version !== after.version) return `${LOCK} does not give ${path} its version ${after.version}`;
  return null;
}

/* The lockfile without the versions of the repository's own packages and its own: what a release leaves as it was. */
function lockWithoutVersions(lock) {
  const packages = Object.entries(lock.packages).map(([key, entry]) => [key, isOwnPackage(key) && isObject(entry) ? withoutVersion(entry) : entry]);
  return { ...withoutVersion(lock), packages: Object.fromEntries(packages) };
}

/* Each version the lockfile moves is the new version of a package.json the commit changes with it. */
function lockProblem({ before, after }, manifests) {
  if (!isObject(before?.packages) || !isObject(after?.packages)) return `${LOCK} is not a lockfile with packages`;
  if (!same(lockWithoutVersions(before), lockWithoutVersions(after))) return `${LOCK} changes more than the versions of the repository's own packages`;
  const moved = Object.keys(after.packages).filter(key => isOwnPackage(key) && after.packages[key]?.version !== before.packages[key]?.version);
  const alone = moved.find(key => manifests.get(key)?.version !== after.packages[key].version);
  if (alone !== undefined) return `${LOCK} changes the version of ${alone || 'the root'} without the same version in its package.json`;
  if (after.version !== before.version && after.version !== manifests.get('')?.version) return `${LOCK} changes its own version to ${after.version}, which the root package.json does not`;
  return null;
}

/* What the commit changes beyond the versions and the notes, in words; null when nothing. */
export function beyondVersionAndNotes(changes, read) {
  const other = otherPath(changes);
  if (other) return other;
  const files = changes.filter(({ path }) => path !== NOTES).map(({ path }) => ({ path, ...read(path) }));
  const reformatted = files.find(({ before, after }) => !onlyVersionLines(before, after));
  if (reformatted) return `${reformatted.path} changes lines other than its "version" lines`;
  const parsed = files.map(({ path, before, after }) => ({ path, before: objectOf(before), after: objectOf(after) }));
  const lock = parsed.find(({ path }) => path === LOCK);
  const manifests = parsed.filter(({ path }) => path !== LOCK);
  const problem = manifests.map(manifest => manifestProblem(manifest, lock)).find(Boolean);
  if (problem) return problem;
  return lock ? lockProblem(lock, new Map(manifests.map(({ path, after }) => [folderOf(path), after]))) : null;
}
