import { basename } from 'node:path';
import { LIGHT_CHECK_TOOLS } from './command-guard.js';

/* Which commands under a machine check slot are light: checks of types, lint, format and quality, and of the test files a
   runner is given, which need little disk beside the files they read. A build, a browser suite, an image or an install is
   heavy and keeps the larger level of free space the node waits for, and so is a test runner given no test file, which
   runs a whole suite, or asked for coverage. A command that is not known to be light is heavy. */

const TESTS = new Set(['vitest', 'jest', 'pytest']);
const LIGHT = new Set([...LIGHT_CHECK_TOOLS, ...TESTS]);
/* A test file as a runner is given it: a.test.ts, b.spec.jsx, test_c.py or d_test.py, also with the case after ::. */
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py)(?:::.*)?$/;
/* Coverage, as vitest, jest and pytest are asked for it: it writes data of every file a test reaches. */
const COVERAGE = /^--(?:coverage|cov|collect-?coverage)(?:$|[.=-])/i;
const PYTHON = new Set(['python', 'python3']);
/* Programs that run the next word as a program, after their own options. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'yarn']);
/* Package managers that do so after one of these words: pnpm exec tsc, npm exec -- eslint. */
const EXEC = new Set(['npm', 'pnpm']);
const NODE = new Set(['node', 'nodejs']);
const HOPS = 8;

const program = (word: string) => basename(word).replace(/\.[cm]?js$/, '');
const options = (words: readonly string[]) => {
  let at = 0;
  while (words[at]?.startsWith('-')) at++;
  return at;
};
/* Vitest in a browser needs the browser and its files. */
const browser = (words: readonly string[]) => words.some(word => word === '--browser' || word.startsWith('--browser.') || word.startsWith('--browser='));
/* A test runner is light given test files by name, without a browser or coverage; a tool of types, style or quality always. */
const light = (name: string, words: readonly string[]) =>
  !TESTS.has(name) || (words.some(word => TEST_FILE.test(word)) && !browser(words) && !words.some(word => COVERAGE.test(word)));

/* A program and the words after it. */
type Step = { name: string; rest: readonly string[] };

/* Where, in the words after a program, the program it runs begins; null for a program that runs none. */
function runsFrom({ name, rest }: Step): number | null {
  if (PYTHON.has(name)) return rest[0] === '-m' ? 1 : null;
  if (NODE.has(name) || RUNNERS.has(name)) return options(rest);
  return EXEC.has(name) && rest[0] === 'exec' ? 1 + options(rest.slice(1)) : null;
}

/* The program a wrapper runs, with the words after it. */
function inner(step: Step): Step | null {
  const from = runsFrom(step), word = from === null ? undefined : step.rest[from];
  return word === undefined ? null : { name: program(word), rest: step.rest.slice(from! + 1) };
}

export function lightCheck(command: readonly string[]): boolean {
  let step: Step | null = { name: program(command[0] ?? ''), rest: command.slice(1) };
  for (let hop = 0; step && hop < HOPS; hop++) {
    if (LIGHT.has(step.name)) return light(step.name, step.rest);
    step = inner(step);
  }
  return false;
}
