import { parseNameStatus } from '../author-check/plan.mjs';
import { versionMoves } from '../release/workspace-versions.mjs';

/* What changed from base to sha for the tests to be chosen by. A package file of ours where only our own versions moved, as a
   release moves them, is no change; any other change of it still is. */
export function changesSince(base, sha, git) {
  const changes = parseNameStatus(git('diff', '--name-status', '-z', '--find-renames', base, sha));
  let workspaces = [];
  try { workspaces = JSON.parse(git('show', `${sha}:package.json`)).workspaces ?? []; } catch { /* no package.json, no workspaces */ }
  return versionMoves(changes, workspaces, path => [git('show', `${base}:${path}`), git('show', `${sha}:${path}`)]);
}
