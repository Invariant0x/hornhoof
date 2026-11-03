import { execFileSync } from 'node:child_process';
import { turnNumber } from './versions.mjs';

export const gitValue = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();

export function turnOf(root, supplied) {
  if (supplied !== undefined) return turnNumber(supplied);
  const match = /^turn-(\d+)$/.exec(gitValue(root, ['branch', '--show-current']));
  if (!match) throw new Error('Use a turn-N branch or supply the turn number explicitly.');
  return turnNumber(match[1]);
}
