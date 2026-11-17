import { changelogSections, requireNotes } from './changelog.mjs';
import { gitValue, turnOf } from './git.mjs';
import { turnNumber, versionParts } from './versions.mjs';

export function checkArguments(args) {
  if (!args.length) return { local: false };
  if (args.length === 1 && args[0] === '--local') return { local: true };
  if (args.length === 2 && args[0] === '--turn') return { local: false, turn: String(turnNumber(args[1])) };
  throw new Error('Usage: check-release.mjs [--local | --turn N]');
}

function checkManifests(project) {
  versionParts(project.version);
  for (const { path, data } of project.manifests) {
    if (data.version !== project.version) throw new Error(`${path}: version ${data.version} differs from root ${project.version}.`);
  }
}

function checkUnreleased(project) {
  const tag = `v${project.version}`;
  if (gitValue(project.root, ['tag', '--list', tag])) throw new Error(`${tag} is already released.`);
  const main = JSON.parse(gitValue(project.root, ['show', 'origin/main:package.json'])).version;
  const currentParts = versionParts(project.version), mainParts = versionParts(main);
  const differing = currentParts.findIndex((v, i) => v !== mainParts[i]);
  if (differing >= 0 && currentParts[differing] < mainParts[differing]) throw new Error(`${project.version} is older than origin/main ${main}.`);
}

function checkTurn(project, supplied) {
  const [, turn, patch] = versionParts(project.version);
  if (patch !== 0) return;
  const expected = turnOf(project.root, supplied);
  if (turn !== expected) throw new Error(`Release turn ${turn} differs from expected turn ${expected}.`);
}

/* No commit that goes to a turn branch or main names Claude as its co-author, in any case. Each such commit over origin/main is
   named, so its author can word it again; what main already holds stays as it is. A clone that has no origin/main, as a shallow
   one, has no range to read: the release check before main always has one. */
const CLAUDE_CO_AUTHOR = /co-authored-by:\s*claude/i;
function checkCoAuthors(project) {
  try {
    gitValue(project.root, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  } catch {
    return;
  }
  const log = gitValue(project.root, ['log', '--format=%H%x00%B%x1e', 'origin/main..HEAD']);
  const signed = log.split('\x1e').map(entry => entry.trim().split('\0')).filter(([sha, message]) => sha && CLAUDE_CO_AUTHOR.test(message ?? '')).map(([sha]) => sha);
  if (signed.length) throw new Error(`These commits name Claude as co-author, which no commit may: ${signed.join(', ')}. Word them again without that line.`);
}

export function checkRelease(project, options) {
  checkManifests(project);
  checkCoAuthors(project);
  const section = changelogSections(project.root)[0];
  if (!(options.local && section?.version === 'Unreleased')) requireNotes(section, project.version);
  if (!options.local) {
    checkUnreleased(project);
    checkTurn(project, options.turn);
  }
  return `Release checks passed for ${project.version} (${options.local ? 'local' : 'full'}).\n`;
}
