/* Where agents stumbled in their turns, read from the tool calls and results the nodes report: a program or module that
   was not there, and what they installed by hand. Operations turns these into what to put on nodes ahead. */

export type Missing = { what: string; kind: 'command' | 'python module' | 'node module' };

/* Tool results worth reading, for the database to pick them out before these patterns name what was missing. */
export const MISSING_HINT = 'not found|no module named|cannot find (module|package)|no such file or directory';
/* Tool calls that may install something. */
export const INSTALL_HINT = 'install|global add|add (-g|--global)|npm i ';

const COMMAND = [
  /\b([\w][\w.+-]*): command not found(?!:)/g,
  /command not found: ([\w.+-]+)/g,
  /^(?:\/bin\/)?(?:ba|da|z)?sh: \d+: ([\w.+-]+): not found/gm,
  /env: ['‘]?([\w.+-]+)['’]?: No such file or directory/g,
];
const PYTHON = /No module named ['"]?([\w.]+)['"]?/g;
const NODE = /Cannot find (?:module|package) ['"]([^'"\s]+)['"]/g;
/* A package name, not a file the agent wrote: no path, no node: builtin. */
const PACKAGE = /^(@[\w.-]+\/)?[\w][\w.-]*/;

export function missingIn(text: string): Missing[] {
  const found = new Map<string, Missing>();
  const add = (what: string, kind: Missing['kind']) => found.set(`${kind} ${what}`, { what, kind });
  for (const re of COMMAND) for (const m of text.matchAll(re)) add(m[1]!, 'command');
  for (const m of text.matchAll(PYTHON)) add(m[1]!.split('.')[0]!, 'python module');
  for (const m of text.matchAll(NODE)) {
    const name = PACKAGE.exec(m[1]!)?.[0];
    if (name && !m[1]!.startsWith('node:')) add(name, 'node module');
  }
  return [...found.values()];
}

/* What installs a tool for the agent itself or the machine, not a project's own dependencies. */
const INSTALL =
  /^(?:sudo\s+)?(?:apt(?:-get)?\s+(?:-\S+\s+)*install|pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+(?:pip|tool)\s+install|npm\s+(?:i|install|add)\s+(?:\S+\s+)*?(?:-g|--global)\b|pnpm\s+add\s+(?:-g|--global)|yarn\s+global\s+add|brew\s+install|cargo\s+install|go\s+install|gem\s+install|(?:npx\s+)?playwright\s+install)\b.*/;
const CUT = 120;

export function installsIn(input: string): string[] {
  /* Codex sends the command as its arguments joined by commas. */
  const command = input.replace(/^\/bin\/(?:ba|z)?sh,-l?c,/, '');
  return command
    .split(/&&|\|\||[;|\n]/)
    .map(part => part.trim().replace(/\s+/g, ' '))
    .flatMap(part => (INSTALL.test(part) ? [part.slice(0, CUT)] : []));
}
