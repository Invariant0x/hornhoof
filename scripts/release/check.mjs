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

export function checkRelease(project, options) {
  checkManifests(project);
  const section = changelogSections(project.root)[0];
  if (!(options.local && section?.version === 'Unreleased')) requireNotes(section, project.version);
  if (!options.local) {
    checkUnreleased(project);
    checkTurn(project, options.turn);
  }
  return `Release checks passed for ${project.version} (${options.local ? 'local' : 'full'}).\n`;
}
