/* Where agents stumbled in their turns, read from the tool calls and results the nodes report: a program or module that
   was not there, and what they installed by hand. Operations turns these into what to put on nodes ahead. */

export type Missing = { what: string; kind: 'command' | 'python module' | 'node module' };

/* Tool results worth reading, for the database to pick them out before these patterns name what was missing. */
export const MISSING_HINT = 'not found|no module named|cannot find (module|package)|no such file or directory';
/* Tool calls that may install something. */
export const INSTALL_HINT = 'install|global add|add (-g|--global)|npm i ';

/* A shell or a program says what is missing at the start of its own line, after who says it: words with no space or quote,
   each followed by a colon, as zsh:1: gives its line too. The same words inside a line, as in a file read, a search or a
   quote, ran nothing. */
const WHO = String.raw`(?:[^\s'"\x60:]+(?::\d+)?(?: \[[\w-]+\])?: )*`;
/* Where the shell lives, as in /bin/sh. */
const PATH = String.raw`(?:[^\s'"\x60:]*\/)?`;
const said = (what: string, mark = '') => new RegExp(String.raw`^[ \t]*` + mark + WHO + what, 'gm');
const COMMAND = [
  said(String.raw`(?:line \d+: )?([\w][\w.+-]*): command not found(?!:)`),
  said(String.raw`command not found: ([\w.+-]+)`),
  said(String.raw`(?:ba|da|z)?sh: \d+: ([\w.+-]+): not found`, PATH),
  said(String.raw`env: ['‘]?([\w.+-]+)['’]?: No such file or directory`, PATH),
];
/* pytest marks the lines of an error with E. */
const PYTHON = said(String.raw`No module named ['"]?([\w.]+)['"]?`, String.raw`(?:E[ \t]+)?`);
const NODE = said(String.raw`Cannot find (?:module|package) ['"]([^'"\s]+)['"]`);
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
