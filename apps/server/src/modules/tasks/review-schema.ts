import { posix } from 'node:path';
import { z } from 'zod';

export const ReviewSha = z.string().regex(/^[a-f0-9]{40}$/);
export const RepoPath = z.string().min(1).max(500).refine(path => !/[\\\u0000-\u001f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));

const GLOB_META = /[*?[\]{}]/;
const TEST_FILE = /^.+\.(?:test|spec)\..+$/;
const TEST_DIRS = new Set(['test', 'tests', 'e2e']);
/* posix.matchesGlob skips leading dots on segments; validated RepoPath values carry no control characters. */
const dotSafe = (value: string): string => value.replace(/(^|\/)\./g, '$1\u0001');

export function validScopePaths(paths: readonly string[]): boolean {
  return paths.every(pattern => RepoPath.safeParse(pattern).success);
}

/* Accompanying test files and test, tests and e2e folders are allowed on any scoped task. */
function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const file = parts[parts.length - 1]!;
  return TEST_FILE.test(file) || parts.slice(0, -1).some(dir => TEST_DIRS.has(dir));
}

function matchesScopePattern(path: string, pattern: string): boolean {
  if (!RepoPath.safeParse(pattern).success) return false;
  if (!GLOB_META.test(pattern)) return path === pattern;
  return posix.matchesGlob(dotSafe(path), dotSafe(pattern));
}

export function pathInScope(path: string, patterns: readonly string[]): boolean {
  if (!RepoPath.safeParse(path).success || !patterns.length) return false;
  return isTestPath(path) || patterns.some(pattern => matchesScopePattern(path, pattern));
}
