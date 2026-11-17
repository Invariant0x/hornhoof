/* What a command asks of this machine, told from its text before any of it runs. Whole test suites go through run_tests;
   installs, named test files and quality stages run in the workspace. One policy for the node's own hook path, so it
   stands alone: no package of the project, nothing spawned, no network, and a script file or manifest is only ever read.

   This is a finite guard of recognized shapes that keeps machines free, not a sandbox. A program it cannot see into runs with
   coverage 'opaque', which is no claim that it is light. At a recognized check or package boundary, what it cannot tell is
   refused. Nothing here says a CLI respects a refusal: each program and mode has to prove that itself. */
import { lstat as lstatOf, open, readdir, realpath as realpathOf } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';

export type CommandInput = { command: string | readonly string[]; cwd: string; workspaceRoot: string };
export type CommandFiles = {
  /* What stands at this path, a link counting as a link. */
  lstat(path: string): Promise<'file' | 'directory' | 'symlink' | 'other' | null>;
  realpath(path: string): Promise<string | null>;
  /* A regular file's text, or null when it is anything else or longer than maxBytes. */
  read(path: string, maxBytes: number): Promise<string | null>;
  /* The names a folder holds, or null when it is no folder. */
  list(path: string): Promise<string[] | null>;
};
type CommandCoverage = 'recognized' | 'opaque';
export type CommandDenial = { allow: false; code: 'whole_suite_local' | 'command_guard_unavailable'; category: string };
export type AgentCommandVerdict = { allow: true; kind: 'ordinary' | 'test_files' | 'lightweight_screenshot'; coverage: CommandCoverage } | CommandDenial;
type WorkCommandVerdict = { allow: true; kind: 'ordinary' | 'dependency_preparation' | 'lightweight_screenshot'; coverage: CommandCoverage } | CommandDenial;

/* stages: of one text. walked: of a whole command, with all the scripts it reaches. */
export const COMMAND_LIMITS = { commandBytes: 65_536, nesting: 32, stages: 256, walked: 4096, resolving: 8, fileBytes: 1_048_576, fileReads: 32 };

const REFUSAL = 'запусти через run_tests';

export const localCommandFiles: CommandFiles = {
  lstat: async path => {
    const found = await lstatOf(path).catch(() => null);
    if (!found) return null;
    if (found.isSymbolicLink()) return 'symlink';
    if (found.isFile()) return 'file';
    return found.isDirectory() ? 'directory' : 'other';
  },
  realpath: path => realpathOf(path).catch(() => null),
  list: path => readdir(path).catch(() => null),
  read: async (path, maxBytes) => {
    const found = await lstatOf(path).catch(() => null);
    if (!found?.isFile() || found.size > maxBytes) return null;
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      return bytesRead > maxBytes ? null : buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/* The shell's text as far as it matters here: what runs, and which words of it are known before it runs. */
type Word = { text: string; literal: boolean; glob: boolean; assign: boolean; scripts: Step[][] };
type Stdin = { text: string; literal: boolean };
type Simple = { kind: 'simple'; assigns: Word[]; words: Word[]; scripts: Step[][]; stdin: Stdin | null };
/* same: this shell. child: a shell of its own. branch: may run or not. loop: may run many times. */
type Scope = 'same' | 'child' | 'branch' | 'loop';
type Step = Simple | { kind: 'nested'; scope: Scope; body: Step[] };
type Redirected = Pick<Simple, 'scripts' | 'stdin'>;
type Heredoc = { into: Redirected; delimiter: string; strip: boolean; raw: boolean };

class Unreadable extends Error {
  constructor(readonly category: 'malformed' | 'over_budget') {
    super(category);
  }
}

type ParseBudget = { stages: number; depth: number };

const BLANK = /[ \t]/;
const ENDS_WORD = /[ \t\n;&|()<>]/;
const COMMAND_WORD = /^(?:if|then|elif|else|fi|for|select|while|until|do|done|case|esac|function|\{|\})(?=[\s;&|()<>]|$)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const BRACES = /^\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/;
const NAME_AFTER_DOLLAR = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/;
const REDIRECTION = /^(?:[0-9]*(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)|&>>|&>)/;
const FUNCTION_PARENS = /^[ \t]*\([ \t]*\)/;

const noWord = (): Word => ({ text: '', literal: true, glob: false, assign: false, scripts: [] });
const nested = (scope: Scope, body: Step[]): Step => ({ kind: 'nested', scope, body });
const holdsNothing = ({ words, assigns, scripts, stdin }: Simple): boolean => !words.length && !assigns.length && !scripts.length && !stdin;

/* A small recursive reader of the shell's grammar. It never expands or runs anything: words it cannot know are marked so. */
class ShellReader {
  private at = 0;
  private heredocs: Heredoc[] = [];

  constructor(private readonly source: string, private readonly budget: ParseBudget) {}

  script(): Step[] {
    const steps = this.list([]);
    if (this.at < this.source.length) throw new Unreadable('malformed');
    return steps;
  }

  private list(closers: readonly string[]): Step[] {
    const steps: Step[] = [];
    for (;;) {
      this.separators();
      if (this.at >= this.source.length || this.closing(closers)) return steps;
      steps.push(this.pipeline());
      this.andOr();
    }
  }

  private closing(closers: readonly string[]): boolean {
    return closers.some(closer => (/^[a-z}]/.test(closer) ? this.keyword(closer) : this.source.startsWith(closer, this.at)));
  }

  private keyword(word: string): boolean {
    if (!this.source.startsWith(word, this.at)) return false;
    const after = this.source[this.at + word.length];
    return after === undefined || ENDS_WORD.test(after);
  }

  private expect(word: string): void {
    this.blanks();
    if (!this.source.startsWith(word, this.at)) throw new Unreadable('malformed');
    this.at += word.length;
  }

  private blanks(): void {
    for (;;) {
      const char = this.source[this.at];
      if (char !== undefined && BLANK.test(char)) this.at++;
      else if (this.source.startsWith('\\\n', this.at)) this.at += 2;
      else if (char === '#') this.comment();
      else return;
    }
  }

  private comment(): void {
    const end = this.source.indexOf('\n', this.at);
    this.at = end < 0 ? this.source.length : end;
  }

  private newlines(): void {
    this.blanks();
    while (this.source[this.at] === '\n') {
      this.newline();
      this.blanks();
    }
  }

  private newline(): void {
    this.at++;
    for (const heredoc of this.heredocs.splice(0)) this.heredocBody(heredoc);
  }

  private separators(): void {
    for (;;) {
      this.blanks();
      const char = this.source[this.at];
      if (char === '\n') this.newline();
      else if (this.plainSeparator(char)) this.at++;
      else return;
    }
  }

  private plainSeparator(char: string | undefined): boolean {
    const next = this.source[this.at + 1];
    if (char === ';') return next !== ';' && next !== '&';
    return char === '&' && next !== '&' && next !== '>';
  }

  private andOr(): void {
    this.blanks();
    if (this.source.startsWith('&&', this.at) || this.source.startsWith('||', this.at)) {
      this.at += 2;
      this.newlines();
    }
  }

  private pipeline(): Step {
    this.blanks();
    if (this.keyword('!')) {
      this.at++;
      this.blanks();
    }
    const parts = [this.command()];
    while (this.pipeAhead()) {
      this.at += this.source[this.at + 1] === '&' ? 2 : 1;
      this.newlines();
      parts.push(this.command());
    }
    return parts.length === 1 ? parts[0]! : nested('same', parts.map(part => nested('child', [part])));
  }

  private pipeAhead(): boolean {
    this.blanks();
    return this.source[this.at] === '|' && this.source[this.at + 1] !== '|';
  }

  private command(): Step {
    this.blanks();
    if (++this.budget.stages > COMMAND_LIMITS.stages || ++this.budget.depth > COMMAND_LIMITS.nesting) throw new Unreadable('over_budget');
    try {
      return this.compound() ?? this.simple();
    } finally {
      this.budget.depth--;
    }
  }

  private compound(): Step | null {
    const step = this.compoundStep();
    return step && this.withRedirections(step);
  }

  private compoundStep(): Step | null {
    if (this.arithmeticEnd() !== null) return this.arithmeticCommand();
    if (this.source[this.at] === '(') return this.enclosed(')', 'child');
    if (this.keyword('[[')) return this.testCommand();
    const word = COMMAND_WORD.exec(this.source.slice(this.at, this.at + 10))?.[0];
    return word ? this.reservedStep(word) : null;
  }

  private reservedStep(word: string): Step {
    switch (word) {
      case 'if': return this.ifStep();
      case 'case': return this.caseStep();
      case 'function': return this.functionStep();
      case '{': return this.enclosed('}', 'same');
      default: return this.loopStep(word);
    }
  }

  private loopStep(word: string): Step {
    switch (word) {
      case 'while': case 'until': return this.whileStep(word);
      case 'for': case 'select': return this.forStep(word);
      default: throw new Unreadable('malformed');
    }
  }

  private withRedirections(step: Step): Step {
    const into: Redirected = { scripts: [], stdin: null };
    while (this.redirection(into));
    return into.scripts.length ? nested('same', [step, ...into.scripts.map(script => nested('child', script))]) : step;
  }

  private enclosed(close: string, scope: Scope): Step {
    this.at++;
    const body = this.list([close]);
    this.expect(close);
    return nested(scope, body);
  }

  private arithmeticCommand(): Step {
    this.skipArithmetic();
    return { kind: 'simple', assigns: [], words: [{ ...noWord(), text: ':' }], scripts: [], stdin: null };
  }

  private skipArithmetic(): void {
    const end = this.arithmeticEnd();
    if (end === null) throw new Unreadable('malformed');
    this.at = end;
  }

  /* As the shell tells them: (( is arithmetic only when its parentheses close together, or two subshells open here. */
  private arithmeticEnd(): number | null {
    if (!this.source.startsWith('((', this.at)) return null;
    let depth = 2;
    for (let at = this.at + 2; at < this.source.length; at++) {
      const char = this.source[at];
      if (char === '(') depth++;
      else if (char === ')' && --depth === 1) return this.source[at + 1] === ')' ? at + 2 : null;
    }
    return null;
  }

  /* Inside [[ ]] the operators are words. */
  private testCommand(): Step {
    this.at += 2;
    const simple: Simple = { kind: 'simple', assigns: [], words: [{ ...noWord(), text: '[[' }], scripts: [], stdin: null };
    for (;;) {
      this.newlines();
      if (this.at >= this.source.length) throw new Unreadable('malformed');
      if (this.keyword(']]')) break;
      if (ENDS_WORD.test(this.source[this.at]!)) this.at++;
      else simple.scripts.push(...this.word()!.scripts);
    }
    this.at += 2;
    return simple;
  }

  private ifStep(): Step {
    this.at += 2;
    const body = this.list(['then']);
    this.expect('then');
    body.push(...this.list(['elif', 'else', 'fi']));
    while (this.keyword('elif')) {
      this.at += 4;
      body.push(...this.list(['then']));
      this.expect('then');
      body.push(...this.list(['elif', 'else', 'fi']));
    }
    if (this.keyword('else')) {
      this.at += 4;
      body.push(...this.list(['fi']));
    }
    this.expect('fi');
    return nested('branch', body);
  }

  private whileStep(word: string): Step {
    this.at += word.length;
    const body = this.list(['do']);
    this.expect('do');
    body.push(...this.list(['done']));
    this.expect('done');
    return nested('loop', body);
  }

  private forStep(word: string): Step {
    this.at += word.length;
    this.blanks();
    const body = this.source.startsWith('((', this.at) ? this.arithmeticFor() : this.forWords();
    this.separators();
    this.expect('do');
    body.push(...this.list(['done']));
    this.expect('done');
    return nested('loop', body);
  }

  private arithmeticFor(): Step[] {
    this.skipArithmetic();
    return [];
  }

  private forWords(): Step[] {
    if (!this.word()) throw new Unreadable('malformed');
    this.blanks();
    if (!this.keyword('in')) return [];
    this.at += 2;
    const body: Step[] = [];
    for (let word = this.wordAfterBlanks(); word; word = this.wordAfterBlanks()) body.push(...word.scripts.map(script => nested('child', script)));
    return body;
  }

  private wordAfterBlanks(): Word | null {
    this.blanks();
    return this.word();
  }

  private caseStep(): Step {
    this.at += 4;
    const subject = this.wordAfterBlanks();
    if (!subject) throw new Unreadable('malformed');
    this.blanks();
    if (!this.keyword('in')) throw new Unreadable('malformed');
    this.at += 2;
    const body: Step[] = subject.scripts.map(script => nested('child', script));
    for (this.separators(); !this.keyword('esac'); this.separators()) body.push(...this.caseArm());
    this.at += 4;
    return nested('branch', body);
  }

  private caseArm(): Step[] {
    if (this.at >= this.source.length) throw new Unreadable('malformed');
    if (this.source[this.at] === '(') this.at++;
    const body = this.casePatterns();
    this.expect(')');
    body.push(...this.list([';;', ';&', 'esac']));
    if (this.source.startsWith(';;&', this.at)) this.at += 3;
    else if (!this.keyword('esac') && this.source[this.at] === ';') this.at += 2;
    return body;
  }

  private casePatterns(): Step[] {
    const body: Step[] = [];
    for (;;) {
      const pattern = this.wordAfterBlanks();
      if (!pattern) throw new Unreadable('malformed');
      body.push(...pattern.scripts.map(script => nested('child', script)));
      this.blanks();
      if (this.source[this.at] !== '|') return body;
      this.at++;
    }
  }

  private functionStep(): Step {
    this.at += 'function'.length;
    if (!this.wordAfterBlanks()) throw new Unreadable('malformed');
    const parens = FUNCTION_PARENS.exec(this.source.slice(this.at));
    if (parens) this.at += parens[0].length;
    return this.functionBody();
  }

  /* What a function holds is told where it stands, whether it is ever called or not. */
  private functionBody(): Step {
    this.newlines();
    return nested('loop', [this.command()]);
  }

  private simple(): Step {
    const simple: Simple = { kind: 'simple', assigns: [], words: [], scripts: [], stdin: null };
    for (;;) {
      this.blanks();
      if (this.redirection(simple)) continue;
      const word = this.word();
      if (!word) break;
      if (word.assign && !simple.words.length) this.assignment(word, simple);
      else simple.words.push(word);
      if (this.namesFunction(simple)) return this.functionAfterName();
    }
    if (holdsNothing(simple)) throw new Unreadable('malformed');
    return simple;
  }

  private namesFunction({ words, assigns }: Simple): boolean {
    return words.length === 1 && !assigns.length && FUNCTION_PARENS.test(this.source.slice(this.at));
  }

  private functionAfterName(): Step {
    this.at += FUNCTION_PARENS.exec(this.source.slice(this.at))![0].length;
    return this.functionBody();
  }

  private assignment(word: Word, simple: Simple): void {
    simple.assigns.push(word);
    if (this.source[this.at] !== '(' || !word.text.endsWith('=')) return;
    this.at++;
    for (this.newlines(); this.source[this.at] !== ')'; this.newlines()) {
      const item = this.word();
      if (!item) throw new Unreadable('malformed');
      simple.scripts.push(...item.scripts);
    }
    this.at++;
  }

  /* Reads one redirection, if one stands here, and keeps what its target runs. */
  private redirection(into: Redirected): boolean {
    this.blanks();
    const start = this.at;
    const operator = REDIRECTION.exec(this.source.slice(start, start + 20))?.[0];
    if (!operator || this.source[start + operator.length] === '(') return false;
    this.at += operator.length;
    const from = this.afterBlanks();
    const target = this.wordAfterBlanks();
    if (!target) throw new Unreadable('malformed');
    into.scripts.push(...target.scripts);
    this.noteInput(operator, target, into, this.source.slice(from, this.at));
    return true;
  }

  private afterBlanks(): number {
    let at = this.at;
    while (BLANK.test(this.source[at] ?? '')) at++;
    return at;
  }

  private noteInput(operator: string, target: Word, into: Redirected, written: string): void {
    if (operator.endsWith('<<<')) into.stdin = { text: target.text, literal: target.literal };
    else if (operator.endsWith('<<') || operator.endsWith('<<-')) {
      this.heredocs.push({ into, delimiter: target.text, strip: operator.endsWith('-'), raw: /['"\\]/.test(written) });
    }
  }

  private heredocBody({ into, delimiter, strip, raw }: Heredoc): void {
    const lines: string[] = [];
    while (this.at < this.source.length) {
      const end = this.source.indexOf('\n', this.at);
      const stop = end < 0 ? this.source.length : end;
      const line = this.source.slice(this.at, stop);
      this.at = end < 0 ? stop : stop + 1;
      const shown = strip ? line.replace(/^\t+/, '') : line;
      if (shown === delimiter) break;
      lines.push(shown);
    }
    this.keepBody(into, lines.join('\n'), raw);
  }

  private keepBody(into: Redirected, body: string, raw: boolean): void {
    if (raw) {
      into.stdin = { text: body, literal: true };
      return;
    }
    const word = new ShellReader(body, this.budget).wholeAsQuoted();
    into.scripts.push(...word.scripts);
    into.stdin = { text: word.text, literal: word.literal };
  }

  private wholeAsQuoted(): Word {
    const word = noWord();
    this.quoted(word, null);
    return word;
  }

  private word(): Word | null {
    const start = this.at;
    const word = noWord();
    while (this.at < this.source.length) {
      const char = this.source[this.at]!;
      if (this.processSubstitutionAhead(char)) this.processSubstitution(word);
      else if (ENDS_WORD.test(char)) break;
      else this.wordPart(char, word);
    }
    if (this.at === start) return null;
    word.assign = ASSIGNMENT.test(this.source.slice(start, this.at));
    return word;
  }

  private processSubstitutionAhead(char: string): boolean {
    return (char === '<' || char === '>') && this.source[this.at + 1] === '(';
  }

  private processSubstitution(word: Word): void {
    this.at += 2;
    this.substitutionBody(word);
  }

  private substitutionBody(word: Word): void {
    if (++this.budget.depth > COMMAND_LIMITS.nesting) throw new Unreadable('over_budget');
    word.scripts.push(this.list([')']));
    this.budget.depth--;
    this.expect(')');
    word.literal = false;
  }

  private wordPart(char: string, word: Word): void {
    switch (char) {
      case '\\': return this.escaped(word);
      case "'": return this.singleQuoted(word);
      case '"': this.at++; return this.quoted(word, '"');
      case '$': return this.dollar(word);
      case '`': return this.backticks(word);
      default: return this.plain(char, word);
    }
  }

  private plain(char: string, word: Word): void {
    if ('*?['.includes(char) || (char === '{' && BRACES.test(this.source.slice(this.at, this.at + 4096)))) word.glob = true;
    if (char === '~' && !word.text) word.literal = false;
    word.text += char;
    this.at++;
  }

  private escaped(word: Word): void {
    const next = this.source[this.at + 1];
    this.at += 2;
    if (next !== '\n') word.text += next ?? '';
  }

  private singleQuoted(word: Word): void {
    const end = this.source.indexOf("'", this.at + 1);
    if (end < 0) throw new Unreadable('malformed');
    word.text += this.source.slice(this.at + 1, end);
    this.at = end + 1;
  }

  /* close: the quote that ends it, or none for a heredoc's body, where a quote is a plain letter. */
  private quoted(word: Word, close: string | null): void {
    while (this.at < this.source.length) {
      const char = this.source[this.at]!;
      if (char === close) {
        this.at++;
        return;
      }
      this.quotedPart(char, word);
    }
    if (close) throw new Unreadable('malformed');
  }

  private quotedPart(char: string, word: Word): void {
    if (char === '\\') this.escapedInQuotes(word);
    else if (char === '$') this.dollar(word);
    else if (char === '`') this.backticks(word);
    else {
      word.text += char;
      this.at++;
    }
  }

  private escapedInQuotes(word: Word): void {
    const next = this.source[this.at + 1] ?? '';
    if ('$`"\\'.includes(next) && next) word.text += next;
    else if (next !== '\n') word.text += `\\${next}`;
    this.at += 2;
  }

  private dollar(word: Word): void {
    const rest = this.source.slice(this.at + 1, this.at + 2);
    if (this.source.startsWith('$((', this.at)) this.arithmeticWord(word);
    else if (rest === '(') {
      this.at += 2;
      this.substitutionBody(word);
    } else if (rest === '{') this.bracedName(word);
    else if (rest === "'") this.ansiQuoted(word);
    else if (rest === '"') this.at++;
    else this.plainName(word);
  }

  private plainName(word: Word): void {
    const name = NAME_AFTER_DOLLAR.exec(this.source.slice(this.at + 1, this.at + 256))?.[0];
    if (name) {
      word.literal = false;
      this.at += 1 + name.length;
    } else {
      word.text += '$';
      this.at++;
    }
  }

  private arithmeticWord(word: Word): void {
    word.literal = false;
    this.at += 3;
    let depth = 2;
    while (depth > 0) {
      const char = this.source[this.at++];
      if (char === undefined) throw new Unreadable('malformed');
      if (char === '(') depth++;
      else if (char === ')') depth--;
    }
  }

  private bracedName(word: Word): void {
    word.literal = false;
    this.at += 2;
    for (;;) {
      const char = this.source[this.at];
      if (char === undefined) throw new Unreadable('malformed');
      if (char === '}') {
        this.at++;
        return;
      }
      this.wordPartInBraces(char, word);
    }
  }

  private wordPartInBraces(char: string, word: Word): void {
    const inner = noWord();
    if ('\\\'"$`'.includes(char)) this.wordPart(char, inner);
    else this.at++;
    word.scripts.push(...inner.scripts);
  }

  /* With no escape it is plain text. With one it says something only the shell works out. */
  private ansiQuoted(word: Word): void {
    this.at += 2;
    const start = this.at;
    while (this.source[this.at] !== "'") {
      if (this.at >= this.source.length) throw new Unreadable('malformed');
      this.at += this.source[this.at] === '\\' ? 2 : 1;
    }
    const text = this.source.slice(start, this.at);
    if (text.includes('\\')) word.literal = false;
    else word.text += text;
    this.at++;
  }

  private backticks(word: Word): void {
    let end = this.at + 1;
    while (end < this.source.length && this.source[end] !== '`') end += this.source[end] === '\\' ? 2 : 1;
    if (end >= this.source.length) throw new Unreadable('malformed');
    const inner = this.source.slice(this.at + 1, end).replace(/\\([`$\\])/g, '$1');
    word.scripts.push(this.innerScript(inner));
    word.literal = false;
    this.at = end + 1;
  }

  private innerScript(inner: string): Step[] {
    if (++this.budget.depth > COMMAND_LIMITS.nesting) throw new Unreadable('over_budget');
    const script = new ShellReader(inner, this.budget).script();
    this.budget.depth--;
    return script;
  }
}

function readShell(source: string): { steps: Step[] } | { category: Category } {
  if (source.includes('\0')) return { category: 'malformed' };
  try {
    return { steps: new ShellReader(source, { stages: 0, depth: 0 }).script() };
  } catch (error) {
    if (error instanceof Unreadable) return { category: error.category };
    throw error;
  }
}

/* What one stage came to. */
type Category =
  | 'dependency_install' | 'implicit_install' | 'build' | 'types' | 'lint' | 'format' | 'test_scope' | 'browser' | 'coverage' | 'quality' | 'mutation' | 'watch'
  | 'task_runner' | 'package_scope' | 'dynamic_check' | 'unresolved_script' | 'missing_script' | 'script_cycle' | 'malformed' | 'over_budget' | 'package_boundary' | 'guard_failed';
type Finding =
  | { kind: 'ordinary'; coverage: CommandCoverage }
  | { kind: 'test_file' }
  | { kind: 'screenshot' }
  | { kind: 'dependency'; category: Category }
  | { kind: 'check'; category: Category }
  | { kind: 'unavailable'; category: Category };

const RECOGNIZED: Finding = { kind: 'ordinary', coverage: 'recognized' };
const OPAQUE: Finding = { kind: 'ordinary', coverage: 'opaque' };
const check = (category: Category): Finding => ({ kind: 'check', category });
const dependency = (category: Category = 'dependency_install'): Finding => ({ kind: 'dependency', category });
const unavailable = (category: Category): Finding => ({ kind: 'unavailable', category });

/* Where a stage stands. boundary: inside a package script, where a word nobody can know is refused rather than called opaque.
   loop: it may run many times. tainted: its environment can change what a test run does. */
type Place = { cwd: string | null; loop: boolean; boundary: boolean; tainted: boolean; depth: number; chain: readonly string[]; stdin: Stdin | null };

type Handler = (guard: Guard, args: Word[], place: Place) => Promise<void>;

const literalWord = (text: string): Word => ({ ...noWord(), text });
const unknownWord = (): Word => ({ ...noWord(), literal: false });
const isFlag = (word: Word | undefined): boolean => Boolean(word?.literal && word.text.startsWith('-') && word.text !== '-');
const quoteForShell = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const flagName = (text: string): string => text.split('=', 1)[0]!;
/* What a table holds under this word. Any word may come here, and "constructor" is one. */
const own = <T>(table: Readonly<Record<string, T>> | undefined, word: string): T | undefined => (table && Object.hasOwn(table, word) ? table[word] : undefined);

/* A flag at this place: its name, the word that is its value if it takes one, and where the next word stands then. The value may
   be in the flag's own word: --prefix=sub, or -Csub as these short flags have it. npm's -ws is a flag of its own. */
type Flag = { name: string; value: Word | null; after: number };
const ATTACHED = /^-([CwFpc])(?!s$)(.+)$/;
function flagAt(args: Word[], at: number): Flag {
  const { text } = args[at]!;
  const short = ATTACHED.exec(text);
  if (short) return { name: `-${short[1]!}`, value: literalWord(short[2]!), after: at + 1 };
  const name = flagName(text);
  if (text.length > name.length) return { name, value: literalWord(text.slice(name.length + 1)), after: at + 1 };
  return { name, value: args[at + 1] ?? null, after: at + 2 };
}

const TEST_OPTIONS_ENV = /^(?:NODE_OPTIONS|PYTEST_ADDOPTS|VITEST_[A-Z_]*|JEST_[A-Z_]*|npm_config_[a-z_]*)\+?=/;
const taints = (word: Word): boolean => TEST_OPTIONS_ENV.test(word.text);

class Guard {
  readonly found: Finding[] = [];
  private reads = 0;
  private walked = 0;
  private readonly manifests = new Map<string, Manifest | null>();
  private readonly workspaceLists = new Map<string, Promise<Workspace[] | null>>();

  constructor(private readonly files: CommandFiles, readonly root: string, private readonly realRoot: string | null) {}

  note(finding: Finding): void {
    this.found.push(finding);
  }

  /* An unknown word in place of a program: honest about it, unless a package script has it where a check could be. */
  unknown(place: Place): void {
    this.note(place.boundary ? unavailable('dynamic_check') : OPAQUE);
  }

  async steps(steps: Step[], place: Place): Promise<void> {
    for (const step of steps) await this.step(step, place);
  }

  private async step(step: Step, place: Place): Promise<void> {
    if (step.kind === 'simple') return this.simple(step, place);
    if (step.scope === 'same') return this.steps(step.body, place);
    const inner = { ...place, loop: place.loop || step.scope === 'loop' };
    await this.steps(step.body, inner);
    if (step.scope !== 'child' && inner.cwd !== place.cwd) place.cwd = null;
  }

  private async simple(simple: Simple, place: Place): Promise<void> {
    if (++this.walked > COMMAND_LIMITS.walked) return this.note(unavailable('over_budget'));
    for (const script of [...simple.scripts, ...simple.assigns.flatMap(word => word.scripts), ...simple.words.flatMap(word => word.scripts)]) {
      await this.steps(script, { ...place });
    }
    if (!simple.words.length) return this.note(RECOGNIZED);
    const here = simple.stdin || simple.assigns.some(taints) ? { ...place, stdin: simple.stdin, tainted: place.tainted || simple.assigns.some(taints) } : place;
    await this.run(simple.words, here);
    if (here !== place) place.cwd = here.cwd;
  }

  /* One command in words: what it is, by its name and not by anything said of it. */
  async run(words: Word[], place: Place): Promise<void> {
    const first = words[0];
    if (!first) return this.note(RECOGNIZED);
    if (!first.literal) return this.unknown(place);
    const name = commandName(first.text);
    const args = words.slice(1);
    const known = HANDLERS.get(name) ?? toolHandler(name);
    if (known && args.some(word => word.literal && (/^--watch(?:-|=|$)/.test(word.text) || (word.text === '-w' && ['tsc', 'vue-tsc', 'webpack', 'rollup'].includes(name))))) return this.note(check('watch'));
    if (known) return onlyAsks(args) ? this.note(RECOGNIZED) : known(this, args, place);
    if (first.text.includes('/')) return this.file(first, place, false);
    this.note(ORDINARY.has(name) ? RECOGNIZED : OPAQUE);
  }

  async shellText(text: string, place: Place): Promise<void> {
    const inner = this.deeper(place, `text:${text}`);
    if (!inner) return;
    const read = readShell(text);
    if ('category' in read) return this.note(place.boundary ? unavailable('unresolved_script') : unavailable(read.category));
    await this.steps(read.steps, inner);
    place.cwd = inner.cwd;
  }

  private deeper(place: Place, key: string): Place | null {
    if (place.chain.includes(key)) {
      this.note(unavailable('script_cycle'));
      return null;
    }
    if (place.depth >= COMMAND_LIMITS.resolving) {
      this.note(unavailable('over_budget'));
      return null;
    }
    return { ...place, depth: place.depth + 1, chain: [...place.chain, key], stdin: null };
  }

  /* A script file is read and told as its own command, in this workspace only: one outside it, or no script at all, is opaque. */
  async file(path: Word, place: Place, asShell: boolean): Promise<void> {
    if (unknownPath(path, place)) return this.unknown(place);
    const absolute = resolve(place.cwd!, path.text);
    const text = await this.textInside(absolute);
    if (text === null || !(asShell || isShellScript(path.text, text))) return this.note(this.overRead() ? unavailable('over_budget') : OPAQUE);
    const inner = this.deeper(place, `file:${absolute}`);
    if (inner) await this.shellFile(text, inner, place);
  }

  private async shellFile(text: string, inner: Place, place: Place): Promise<void> {
    const read = readShell(text);
    if ('category' in read) return this.unknown(place);
    await this.steps(read.steps, inner);
  }

  private async textInside(absolute: string): Promise<string | null> {
    return (await this.inside(absolute)) ? this.read(absolute) : null;
  }

  overRead(): boolean {
    return this.reads > COMMAND_LIMITS.fileReads;
  }

  /* Whether the path stands under the workspace with no link anywhere on its way. */
  async inside(absolute: string): Promise<boolean> {
    const way = relative(this.root, absolute);
    if (this.realRoot === null || !way || leavesFolder(way)) return false;
    return (await this.files.realpath(absolute)) === join(this.realRoot, way);
  }

  private read(absolute: string): Promise<string | null> {
    if (++this.reads > COMMAND_LIMITS.fileReads) return Promise.resolve(null);
    return this.files.read(absolute, COMMAND_LIMITS.fileBytes);
  }

  /* Whether this word is one regular file in the workspace, tracked or just written. */
  async regularFile(word: Word, place: Place): Promise<boolean> {
    if (unknownPath(word, place) || GLOB_LETTERS.test(word.text)) return false;
    const absolute = resolve(place.cwd!, word.text);
    return (await this.inside(absolute)) && (await this.files.lstat(absolute)) === 'file';
  }

  /* Whether this word is one folder in the workspace. */
  async regularFolder(word: Word, place: Place): Promise<boolean> {
    if (unknownPath(word, place) || GLOB_LETTERS.test(word.text)) return false;
    const absolute = resolve(place.cwd!, word.text);
    return (await this.inside(absolute)) && (await this.files.lstat(absolute)) === 'directory';
  }

  /* An executable the workspace has installed, for npx and its like to find without fetching one. */
  async localBin(tool: string, place: Place): Promise<boolean> {
    if (place.cwd === null) return false;
    for (const folder of this.upToRoot(place.cwd)) if ((await this.files.lstat(join(folder, 'node_modules/.bin', tool))) !== null) return true;
    return false;
  }

  private upToRoot(from: string): string[] {
    const folders: string[] = [];
    for (let folder = from; !leavesFolder(relative(this.root, folder)); folder = dirname(folder)) {
      folders.push(folder);
      if (folder === this.root || folder === dirname(folder)) break;
    }
    return folders;
  }

  async hasManifest(folder: string): Promise<boolean> {
    return (await this.inside(join(folder, 'package.json'))) && (await this.files.lstat(join(folder, 'package.json'))) === 'file';
  }

  /* A package script and what npm runs around it, read from the nearest manifest in the workspace, and told in its folder. */
  async packageScript(name: string, forwarded: Word[], from: string | null, place: Place): Promise<void> {
    if (forwarded.some(word => !word.literal)) return this.note(unavailable('dynamic_check'));
    const found = from === null ? null : await this.nearestScripts(from);
    const stages = found ? stagesOf(found.scripts, name, forwarded) : [];
    if (!stages.length) return this.note(unavailable(this.overRead() ? 'over_budget' : found && !Object.hasOwn(found.scripts, name) ? 'missing_script' : 'unresolved_script'));
    const inner = this.deeper(place, `script:${found!.folder}:${name}`);
    if (!inner) return;
    for (const stage of stages) await this.scriptStage(stage, { ...inner, cwd: found!.folder, boundary: true });
  }

  /* A manifest with no scripts has none of them. One that cannot be read says nothing. */
  private async nearestScripts(from: string): Promise<{ folder: string; scripts: Record<string, unknown> } | null> {
    const folder = await this.manifestFolder(from);
    const manifest = folder === null ? null : await this.manifestOf(folder);
    return manifest && { folder: folder!, scripts: manifest.scripts ?? {} };
  }

  private async scriptStage(text: string, place: Place): Promise<void> {
    const read = readShell(text);
    if ('category' in read) return this.note(unavailable('unresolved_script'));
    await this.steps(read.steps, place);
  }

  private async manifestFolder(from: string): Promise<string | null> {
    for (const folder of this.upToRoot(from)) if (await this.hasManifest(folder)) return folder;
    return null;
  }

  private async scriptsOf(folder: string): Promise<Record<string, unknown> | null> {
    return (await this.manifestOf(folder))?.scripts ?? null;
  }

  private async manifestOf(folder: string): Promise<Manifest | null> {
    if (!this.manifests.has(folder)) this.manifests.set(folder, parseManifest(await this.read(join(folder, 'package.json'))));
    return this.manifests.get(folder)!;
  }

  /* Whether a workspace's own manifest has this script, for --if-present. */
  async hasScript(folder: string, name: string): Promise<boolean> {
    return (await this.hasManifest(folder)) && typeof (await this.scriptsOf(folder))?.[name] === 'string';
  }

  /* The root of the project npm works in from this folder, as npm finds it: the nearest manifest above it in the workspace that
     declares workspaces. A clone inside the agent's folder has its own. Without one, the workspace itself. */
  async projectRoot(from: string | null): Promise<string> {
    if (from !== null) for (const folder of this.upToRoot(from)) if ((await this.hasManifest(folder)) && workspaceGlobs((await this.manifestOf(folder))?.workspaces)) return folder;
    return this.root;
  }

  /* The workspaces of a project's root manifest, as npm finds them: folders its globs match that hold a manifest. Null when a
     glob cannot be listed here or the limits run out. */
  workspaces(root = this.root): Promise<Workspace[] | null> {
    let list = this.workspaceLists.get(root);
    if (!list) this.workspaceLists.set(root, (list = this.findWorkspaces(root)));
    return list;
  }

  private async findWorkspaces(root: string): Promise<Workspace[] | null> {
    const patterns = (await this.hasManifest(root)) ? workspaceGlobs((await this.manifestOf(root))?.workspaces) : null;
    if (!patterns) return null;
    const found: Workspace[] = [];
    for (const pattern of patterns) {
      const folders = await this.expand(pattern, root);
      if (!folders) return null;
      for (const folder of folders) if (!found.some(item => item.folder === folder) && (await this.hasManifest(folder))) found.push({ folder, name: (await this.manifestOf(folder))?.name ?? null });
    }
    return this.overRead() ? null : found;
  }

  /* The folders a glob of a manifest matches, one part of its path at a time. */
  private async expand(pattern: string, root: string): Promise<string[] | null> {
    const parts = pattern.split('/').filter(part => part && part !== '.');
    if (pattern.startsWith('!') || parts.some(part => part === '..' || part.includes('**'))) return null;
    let folders = [root];
    for (const part of parts) {
      const next: string[] = [];
      for (const folder of folders) {
        const names = GLOB_LETTERS.test(part) ? await this.listInside(folder) : [part];
        if (!names) return null;
        next.push(...names.filter(name => name === part || matchesGlob(name, part)).map(name => join(folder, name)));
      }
      if ((this.walked += next.length) > COMMAND_LIMITS.walked) return null;
      folders = next;
    }
    return folders;
  }

  /* A folder's names count as a read, and only a folder of the workspace, or its root, is listed. */
  private async listInside(folder: string): Promise<string[] | null> {
    if (++this.reads > COMMAND_LIMITS.fileReads) return null;
    const known = folder === this.root ? this.realRoot !== null : await this.inside(folder);
    return known ? this.files.list(folder) : null;
  }
}

type Manifest = { name: string | null; scripts: Record<string, unknown> | null; workspaces: unknown };
type Workspace = { folder: string; name: string | null };

/* npm reads workspaces as a list of globs, or as an object with one under packages. */
function workspaceGlobs(value: unknown): string[] | null {
  const list = Array.isArray(value) ? value : (value as { packages?: unknown } | null)?.packages;
  return Array.isArray(list) && list.every((item): item is string => typeof item === 'string') ? list : null;
}

const unknownPath = (word: Word, place: Place): boolean => !word.literal || word.glob || place.cwd === null;
const leavesFolder = (way: string): boolean => way === '..' || way.startsWith('../') || isAbsolute(way);

/* A script with what npm runs around it, and the words it is given: nothing at all when there is no such script. */
function stagesOf(scripts: Record<string, unknown>, name: string, forwarded: Word[]): string[] {
  const text = scripts[name];
  if (typeof text !== 'string') return [];
  const called = [text, ...forwarded.map(word => quoteForShell(word.text))].join(' ');
  return [scripts[`pre${name}`], called, scripts[`post${name}`]].filter((stage): stage is string => typeof stage === 'string');
}

function parseManifest(text: string | null): Manifest | null {
  if (text === null) return null;
  try {
    const manifest = JSON.parse(text) as { name?: unknown; scripts?: unknown; workspaces?: unknown } | null;
    const scripts = manifest?.scripts;
    return {
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      scripts: typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>) : null,
      workspaces: manifest?.workspaces,
    };
  } catch {
    return null;
  }
}

const SHELL_LINE = /^#!.*\b(?:sh|bash|dash|zsh|ksh|ash)\b/;
const isShellScript = (path: string, text: string): boolean => !text.includes('\0') && (SHELL_LINE.test(text) || (path.endsWith('.sh') && !text.startsWith('#!')));
const GLOB_LETTERS = /[*?[\]{}!]/;
const ONLY_ASKS = new Set(['--version', '-v', '-V', '--help', '-h', 'version', 'help']);
const onlyAsks = (args: Word[]): boolean => args.length === 1 && ONLY_ASKS.has(args[0]!.text);
const PYTHON = /^(?:python[0-9.]*|py|pypy[0-9.]*)$/;
const commandName = (text: string): string => {
  const name = basename(text);
  return PYTHON.test(name) ? 'python' : name;
};

const ORDINARY = new Set([
  ':', 'true', 'false', 'echo', 'printf', 'cat', 'ls', 'pwd', 'test', '[', '[[', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'chown', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee',
  'sed', 'awk', 'gawk', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'xxd', 'od', 'stat', 'file', 'du', 'df', 'date', 'sleep', 'which', 'type', 'hash', 'unset', 'set', 'shopt', 'local', 'read', 'wait', 'trap',
  'exit', 'return', 'break', 'continue', 'shift', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'comm', 'patch', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'jq', 'yq', 'git', 'gh', 'hh-attach', 'hh-fetch', 'hh-xlsx',
  'curl', 'wget', 'ps', 'kill', 'pgrep', 'uname', 'id', 'whoami', 'hostname', 'seq', 'less', 'more', 'nl', 'rev', 'tac', 'vi', 'vim', 'nano', 'alias', 'unalias', 'declare', 'typeset', 'umask', 'ulimit', 'dirs',
]);

/* Programs that are a check of one kind, whatever they are given. */
const CHECK_TOOLS = new Map(Object.entries<Category>({
  tsc: 'types', 'vue-tsc': 'types', mypy: 'types', pyright: 'types', pyre: 'types', flow: 'types',
  eslint: 'lint', biome: 'lint', stylelint: 'lint', oxlint: 'lint', tslint: 'lint', ruff: 'lint', flake8: 'lint', pylint: 'lint', rubocop: 'lint', 'golangci-lint': 'lint',
  prettier: 'format', black: 'format', isort: 'format', gofmt: 'format', rustfmt: 'format', yapf: 'format', autopep8: 'format', dprint: 'format',
  webpack: 'build', rollup: 'build', esbuild: 'build', parcel: 'build', tsup: 'build', swc: 'build', babel: 'build', make: 'task_runner', gmake: 'task_runner', cmake: 'build', ninja: 'task_runner', bazel: 'task_runner', buck: 'task_runner', buck2: 'task_runner',
  mvn: 'task_runner', mvnw: 'task_runner', gradle: 'task_runner', gradlew: 'task_runner', ant: 'task_runner', sbt: 'task_runner', msbuild: 'build', rake: 'task_runner',
  turbo: 'task_runner', nx: 'task_runner', lerna: 'task_runner', just: 'task_runner', task: 'task_runner', 'npm-run-all': 'task_runner', 'run-s': 'task_runner', 'run-p': 'task_runner', concurrently: 'task_runner', wireit: 'task_runner',
  unittest: 'test_scope', karma: 'test_scope', ctest: 'test_scope', tox: 'test_scope', nox: 'test_scope',
  kcov: 'coverage', gcovr: 'coverage',
  crapper: 'quality', dryer: 'quality',
  mutator: 'mutation', stryker: 'mutation', mutmut: 'mutation', 'cosmic-ray': 'mutation', pitest: 'mutation', mutant: 'mutation',
  cypress: 'browser', wdio: 'browser', webdriverio: 'browser', testcafe: 'browser', nightwatch: 'browser',
  nodemon: 'watch', watchexec: 'watch', entr: 'watch',
}));

/* Programs whose first word says what they do. */
type ToolSpec = {
  install?: readonly string[];
  heavy?: Readonly<Record<string, Category>>;
  read?: readonly string[];
  /* What comes after this word is a command of its own. */
  run?: readonly string[];
  nested?: Readonly<Record<string, ToolSpec>>;
  /* Called with no word at all. */
  bare?: Finding;
  /* A word not listed. At a package manager nobody can tell what it does, so it is refused. */
  other?: Finding;
};

const READS = ['list', 'ls', 'show', 'search', 'info', 'freeze', 'check', 'config', 'env', 'outdated', 'tree', 'why', 'metadata', 'doc'];
const OPAQUE_REST = { bare: OPAQUE, other: OPAQUE };
const TOOLS = new Map(Object.entries<ToolSpec>({
  pip: { install: ['install', 'download', 'wheel', 'uninstall'], read: READS },
  pip3: { install: ['install', 'download', 'wheel', 'uninstall'], read: READS },
  easy_install: { bare: dependency(), other: dependency() },
  uv: { install: ['sync', 'add', 'remove', 'lock', 'run'], read: READS, nested: { pip: { install: ['install', 'sync', 'uninstall'], read: READS }, tool: { install: ['install', 'run', 'upgrade'], read: READS } } },
  uvx: { bare: dependency(), other: dependency() },
  poetry: { install: ['install', 'add', 'update', 'remove', 'sync', 'lock'], read: READS, run: ['run'] },
  pipenv: { install: ['install', 'sync', 'update', 'uninstall', 'lock'], read: READS, run: ['run'] },
  pdm: { install: ['install', 'add', 'sync', 'update', 'remove'], read: READS, run: ['run'] },
  pipx: { install: ['install', 'upgrade', 'inject', 'run'], read: READS },
  conda: { install: ['install', 'create', 'update', 'env'], read: READS, run: ['run'] },
  mamba: { install: ['install', 'create', 'update', 'env'], read: READS },
  micromamba: { install: ['install', 'create', 'update', 'env'], read: READS },
  gem: { install: ['install', 'update'], read: READS },
  bundle: { bare: dependency(), install: ['install', 'add', 'update'], read: READS, run: ['exec'] },
  bundler: { bare: dependency(), install: ['install', 'add', 'update'], read: READS, run: ['exec'] },
  composer: { install: ['install', 'require', 'update', 'remove'], read: READS },
  brew: { install: ['install', 'upgrade', 'reinstall', 'tap'], read: READS },
  apt: { install: ['install', 'update', 'upgrade', 'full-upgrade', 'build-dep'], read: READS },
  'apt-get': { install: ['install', 'update', 'upgrade', 'dist-upgrade', 'build-dep'], read: READS },
  aptitude: { install: ['install', 'update', 'upgrade'], read: READS },
  apk: { install: ['add', 'update', 'upgrade'], read: READS },
  dnf: { install: ['install', 'update', 'upgrade', 'groupinstall'], read: READS },
  yum: { install: ['install', 'update', 'upgrade', 'groupinstall'], read: READS },
  microdnf: { install: ['install', 'update', 'upgrade'], read: READS },
  zypper: { install: ['install', 'in', 'update', 'up'], read: READS },
  snap: { install: ['install', 'refresh'], read: READS },
  rustup: { read: READS, nested: { toolchain: { install: ['install'], read: READS }, component: { install: ['add'], read: READS }, target: { install: ['add'], read: READS } }, install: ['update', 'install'] },
  corepack: { install: ['prepare', 'install', 'enable', 'up', 'use'], read: READS },
  volta: { install: ['install', 'pin', 'fetch'], read: READS },
  asdf: { install: ['install'], read: READS },
  mise: { install: ['install', 'use'], read: READS },
  cargo: {
    install: ['add', 'install', 'fetch', 'update', 'vendor', 'remove'], read: READS,
    heavy: { build: 'build', b: 'build', check: 'types', c: 'types', test: 'test_scope', t: 'test_scope', clippy: 'lint', bench: 'test_scope', fmt: 'format', run: 'build', r: 'build', nextest: 'test_scope', tarpaulin: 'coverage', 'llvm-cov': 'coverage', mutants: 'mutation' },
  },
  go: { read: READS, heavy: { build: 'build', test: 'test_scope', vet: 'lint', generate: 'build', fmt: 'format' }, install: ['get', 'install'], nested: { mod: { install: ['download', 'tidy', 'vendor', 'get'], read: ['why', 'graph', 'verify', 'edit', 'init'] } }, other: OPAQUE },
  dotnet: { install: ['restore', 'add'], read: READS, heavy: { build: 'build', test: 'test_scope', publish: 'build', format: 'format', pack: 'build', msbuild: 'build' }, other: OPAQUE },
  deno: { install: ['install', 'add', 'cache'], read: READS, heavy: { test: 'test_scope', lint: 'lint', fmt: 'format', check: 'types', compile: 'build', bench: 'test_scope', coverage: 'coverage', task: 'task_runner' }, other: OPAQUE },
  docker: { heavy: { build: 'build', buildx: 'build' }, nested: { compose: { heavy: { build: 'build' }, ...OPAQUE_REST } }, ...OPAQUE_REST },
  vite: { heavy: { build: 'build' }, ...OPAQUE_REST },
  next: { heavy: { build: 'build', lint: 'lint' }, ...OPAQUE_REST },
  nuxt: { heavy: { build: 'build', typecheck: 'types' }, ...OPAQUE_REST },
  astro: { heavy: { build: 'build', check: 'types' }, ...OPAQUE_REST },
}));

function toolHandler(name: string): Handler | null {
  const heavy = CHECK_TOOLS.get(name);
  if (heavy) return guard => Promise.resolve(guard.note(check(heavy)));
  const tool = TOOLS.get(name);
  return tool ? (guard, args, place) => useTool(tool, guard, args, place) : null;
}

async function useTool(tool: ToolSpec, guard: Guard, args: Word[], place: Place): Promise<void> {
  const at = args.findIndex(word => !isFlag(word));
  const sub = args[at];
  if (!sub) return guard.note(tool.bare ?? RECOGNIZED);
  if (!sub.literal) return guard.note(unavailable('dynamic_check'));
  const rest = args.slice(at + 1);
  const inner = own(tool.nested, sub.text);
  if (inner) return useTool(inner, guard, rest, place);
  if (tool.run?.includes(sub.text)) return guard.run(withoutDashes(rest), place);
  guard.note(toolWord(tool, sub.text));
}

function toolWord(tool: ToolSpec, word: string): Finding {
  if (tool.install?.includes(word)) return dependency();
  const heavy = own(tool.heavy, word);
  if (heavy) return check(heavy);
  return tool.read?.includes(word) ? RECOGNIZED : tool.other ?? unavailable('package_boundary');
}

const withoutDashes = (args: Word[]): Word[] => (args[0]?.text === '--' ? args.slice(1) : args);

/* Wrappers run the command that follows them: what is left once their own flags and fixed words are off. */
type Wrapper = { values?: readonly string[]; positional?: number; assigns?: boolean; loop?: boolean; lookup?: readonly string[]; sameShell?: boolean; splits?: boolean };
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: { values: ['-u', '--unset', '-C', '--chdir'], assigns: true, splits: true },
  time: { values: ['-f', '--format', '-o', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '--class', '-n', '--classdata', '-p', '--pid'] },
  timeout: { values: ['-k', '--kill-after', '-s', '--signal'], positional: 1 },
  nohup: {},
  command: { lookup: ['-v', '-V'], sameShell: true },
  builtin: { sameShell: true },
  exec: { values: ['-a'] },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  setsid: {},
  sudo: { values: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt'], assigns: true },
  doas: { values: ['-u', '-C'] },
  'xvfb-run': { values: ['-s', '--server-args', '-n', '--server-num', '-f', '--auth-file', '-e', '--error-file'] },
  'cross-env': { assigns: true },
  'cross-env-shell': { assigns: true },
  'hh-check': {},
  caffeinate: { values: ['-t', '-w'] },
  flock: { values: ['-w', '--timeout', '-E', '--conflict-exit-code'], positional: 1 },
  taskset: { positional: 1 },
  watch: { values: ['-n', '--interval'], loop: true },
};

function changedFolder(flag: string, value: Word | null, place: Place): void {
  if (flag !== '-C' && flag !== '--chdir') return;
  place.cwd = place.cwd !== null && value?.literal ? resolve(place.cwd, value.text) : null;
}

function wrapperRest(wrapper: Wrapper, args: Word[], place: Place): Word[] | null {
  let at = 0;
  while (isFlag(args[at])) {
    const text = args[at]!.text;
    if (text === '--') return args.slice(at + 1);
    if (wrapper.lookup?.includes(text)) return null;
    at = afterWrapperFlag(wrapper, args, at, place);
  }
  return args.slice(afterSettings(wrapper, args, at + (wrapper.positional ?? 0), place));
}

function afterWrapperFlag(wrapper: Wrapper, args: Word[], at: number, place: Place): number {
  const { name, value, after } = flagAt(args, at);
  if (!wrapper.values?.includes(name)) return at + 1;
  changedFolder(name, value, place);
  return after;
}

/* A word nobody can know in the settings may be one more setting: what follows it is still told. */
function afterSettings(wrapper: Wrapper, args: Word[], from: number, place: Place): number {
  let at = from;
  while (wrapper.assigns && (args[at]?.assign || args[at]?.literal === false)) {
    if (taints(args[at]!)) place.tainted = true;
    at++;
  }
  return at;
}

/* The text env -S splits into a command, if it was given one. */
function splitString(args: Word[]): Word | null {
  for (const [at, word] of args.entries()) {
    if (word.text === '-S' || word.text === '--split-string') return args[at + 1] ?? null;
    if (word.text.startsWith('--split-string=')) return { ...word, text: word.text.slice('--split-string='.length) };
    if (!isFlag(word)) return null;
  }
  return null;
}

const wrapperHandler = (wrapper: Wrapper): Handler => async (guard, args, place) => {
  const split = wrapper.splits ? splitString(args) : null;
  if (split) return split.literal ? guard.shellText(split.text, { ...place }) : guard.unknown(place);
  /* What runs may then be other than it looks. */
  if (args.some(word => !word.literal)) guard.unknown(place);
  const inner = { ...place, loop: place.loop || Boolean(wrapper.loop) };
  const rest = wrapperRest(wrapper, args, inner);
  if (!rest?.length) return guard.note(RECOGNIZED);
  await guard.run(rest, inner);
  if (wrapper.sameShell) place.cwd = inner.cwd;
};

/* A shell runs the text it is given, the script it is pointed at, or what it reads on its input. */
const SHELL: Handler = async (guard, args, place) => {
  const at = shellOperand(args);
  const word = args[at];
  if (word && commandFlag(word)) return shellCommand(guard, args[at + 1], place);
  if (word) return guard.file(word, { ...place }, true);
  if (place.stdin?.literal) return guard.shellText(place.stdin.text, { ...place });
  guard.unknown(place);
};

const commandFlag = (word: Word): boolean => word.literal && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text);
const SHELL_OPTION = /^[-+][a-zA-Z]*[oO]$|^--(?:rcfile|init-file)$/;

/* Where a shell's own options end: its -c, or the script it runs. */
function shellOperand(args: Word[]): number {
  let at = 0;
  while (args[at]?.literal && /^[-+]./.test(args[at]!.text) && !commandFlag(args[at]!)) at += SHELL_OPTION.test(args[at]!.text) ? 2 : 1;
  return at;
}

async function shellCommand(guard: Guard, text: Word | undefined, place: Place): Promise<void> {
  if (text?.literal) return guard.shellText(text.text, { ...place });
  guard.unknown(place);
}

const EVAL: Handler = async (guard, args, place) => {
  if (args.every(word => word.literal)) return guard.shellText(args.map(word => word.text).join(' '), place);
  guard.unknown(place);
};

const SOURCE: Handler = async (guard, args, place) => {
  if (args[0]) return guard.file(args[0], place, true);
  guard.note(RECOGNIZED);
};

const CD: Handler = (guard, args, place) => {
  const dirs = args.filter(word => !isFlag(word));
  const dir = dirs[0];
  const known = dir?.literal && !dir.glob && dir.text !== '-' && place.cwd !== null;
  place.cwd = known ? resolve(place.cwd!, dir.text) : null;
  guard.note(RECOGNIZED);
  return Promise.resolve();
};

const EXPORT: Handler = (guard, args, place) => {
  if (args.some(taints)) place.tainted = true;
  guard.note(RECOGNIZED);
  return Promise.resolve();
};

/* What a selector like xargs runs gets its words from somewhere nobody can read here. */
const fromSelector = (guard: Guard, words: Word[], place: Place): Promise<void> => guard.run([...words, unknownWord()], { ...place });

const XARGS_VALUES = ['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--arg-file', '--delimiter', '--replace', '--max-lines', '-j', '--jobs'];
const XARGS: Handler = async (guard, args, place) => {
  let at = 0;
  while (isFlag(args[at])) at += XARGS_VALUES.includes(args[at]!.text) ? 2 : 1;
  const rest = args.slice(at);
  if (!rest.length) return guard.note(RECOGNIZED);
  await fromSelector(guard, rest, place);
};

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND: Handler = async (guard, args, place) => {
  guard.note(RECOGNIZED);
  for (let at = 0; at < args.length; at++) {
    if (!FIND_ACTIONS.has(args[at]!.text)) continue;
    const end = args.findIndex((word, index) => index > at && (word.text === ';' || word.text === '+'));
    const stop = end < 0 ? args.length : end;
    await fromSelector(guard, args.slice(at + 1, stop).filter(word => word.text !== '{}'), place);
    at = stop;
  }
};

/* Flags a test run may carry. Any other can widen its file selection, so it is refused. The value says whether one follows. */
type Flags = Readonly<Record<string, boolean>>;
const VITEST_FLAGS: Flags = { '--config': true, '-c': true, '--project': true, '--root': true, '-r': true, '--dir': true, '--run': false, '--reporter': true, '-t': true, '--testNamePattern': true, '--bail': true, '--silent': false, '--no-color': false, '--color': false, '--testTimeout': true, '--no-coverage': false, '--coverage': false, '--browser': false, '--typecheck': false };
const JEST_FLAGS: Flags = { '--runTestsByPath': false, '-t': true, '--testNamePattern': true, '--silent': false, '--verbose': false, '--ci': false, '--no-cache': false, '-b': false, '--bail': false, '--colors': false, '--reporters': true, '--no-coverage': false, '--coverage': false };
const NODE_FLAGS: Flags = {
  '--test': false, '--experimental-test-coverage': false, '--test-name-pattern': true, '--test-skip-pattern': true, '--test-reporter': true, '--test-reporter-destination': true, '--test-only': false, '--test-timeout': true, '--import': true, '--require': true, '-r': true,
  '--loader': true, '--experimental-loader': true, '--no-warnings': false, '--experimental-strip-types': false, '--experimental-transform-types': false, '--enable-source-maps': false, '--trace-warnings': false, '--conditions': true, '-C': true,
};
const PYTEST_FLAGS: Flags = {
  '-q': false, '-qq': false, '--quiet': false, '-v': false, '-vv': false, '-vvv': false, '--verbose': false, '-x': false, '--exitfirst': false, '-s': false, '--tb': true, '-k': true, '-m': true, '--no-header': false, '--no-summary': false, '--color': true,
  '--cov': true, '--maxfail': true, '--capture': true, '-ra': false, '-rA': false, '-rf': false, '--durations': true, '-p': true, '-l': false, '--showlocals': false, '--disable-warnings': false,
};

/* The literal files a test run names, or what makes its selection unbounded. */
function testSelection(args: Word[], flags: Flags): { files: Word[] } | { category: Category } {
  const files: Word[] = [];
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (!word.literal) return { category: 'dynamic_check' };
    if (word.text === '--') return { files: [...files, ...args.slice(at + 1)] };
    if (!isFlag(word)) files.push(word);
    else if (!(flagName(word.text) in flags)) return { category: /watch/i.test(word.text) ? 'watch' : 'test_scope' };
    else if (word.text === '--cov') continue;
    else if (takesValue(word, flags) && !args[++at]?.literal) return { category: 'dynamic_check' };
  }
  return { files };
}

const takesValue = (word: Word, flags: Flags): boolean => Boolean(flags[flagName(word.text)]) && !word.text.includes('=');

async function namedTests(guard: Guard, args: Word[], flags: Flags, place: Place, selector: (word: Word) => Word = word => word): Promise<void> {
  const selection = testSelection(args, flags);
  if ('category' in selection) return guard.note(check(selection.category));
  const { files } = selection;
  if (place.tainted) return guard.note(check('dynamic_check'));
  if (files.length > 0 && !place.loop) {
    const regular = await Promise.all(files.map(word => guard.regularFile(selector(word), place)));
    if (regular.every(Boolean)) return guard.note({ kind: 'test_file' });
  }
  guard.note(check(files.some(word => !word.literal) ? 'dynamic_check' : 'test_scope'));
}

const VITEST: Handler = async (guard, args, place) => {
  const words = args[0]?.literal && args[0].text === 'run' ? args.slice(1) : args.some(word => word.text === '--run') ? args : null;
  if (!words) return guard.note(check(args.some(word => !word.literal) ? 'dynamic_check' : 'watch'));
  await namedTests(guard, words, VITEST_FLAGS, place);
};

const COVERAGE: Handler = async (guard, args, place) => {
  guard.note(check('coverage'));
  const values = new Set(['--reporter', '-r', '--reports-dir', '--temp-directory', '--include', '--exclude', '--src', '--omit', '--source', '--data-file']);
  let at = 0;
  while (isFlag(args[at])) {
    if (values.has(flagName(args[at]!.text)) && !args[at]!.text.includes('=')) at++;
    at++;
  }
  if (at < args.length) await guard.run(args.slice(args[at]!.text === 'run' ? at + 1 : at), place);
};

const JEST: Handler = (guard, args, place) => namedTests(guard, args, JEST_FLAGS, place);

const withoutTestName = (word: Word): Word => ({ ...word, text: word.text.split('::', 1)[0]! });
const PYTEST: Handler = (guard, args, place) => namedTests(guard, args, PYTEST_FLAGS, place, withoutTestName);

const PLAYWRIGHT_ACTIONS: Readonly<Record<string, Finding>> = {
  install: dependency(), 'install-deps': dependency(), screenshot: { kind: 'screenshot' }, pdf: { kind: 'screenshot' },
  codegen: OPAQUE, 'show-report': OPAQUE, 'show-trace': OPAQUE, open: OPAQUE,
};
const PLAYWRIGHT: Handler = (guard, args, place) => {
  const action = args.find(word => !isFlag(word));
  if (!action?.literal) return Promise.resolve(guard.note(action ? check('dynamic_check') : RECOGNIZED));
  if (action.text === 'test') return namedTests(guard, args.slice(args.indexOf(action) + 1), { '--project': true, '--headed': false, '--reporter': true, '--workers': true, '-g': true, '--grep': true }, place);
  guard.note(own(PLAYWRIGHT_ACTIONS, action.text) ?? unavailable('package_boundary'));
  return Promise.resolve();
};

const BROWSER: Handler = (guard, args) => {
  guard.note(args.some(word => word.literal && /^--screenshot(?:=|$)/.test(word.text)) ? { kind: 'screenshot' } : OPAQUE);
  return Promise.resolve();
};

/* A file under node_modules is its package's tool, however it is reached. */
const PACKAGE_TOOLS: Readonly<Record<string, string>> = { typescript: 'tsc', '@playwright/test': 'playwright', 'vue-tsc': 'vue-tsc', '@biomejs/biome': 'biome', '@stryker-mutator/core': 'stryker' };
function toolInNodeModules(path: string): string | null {
  const bin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/.exec(path);
  if (bin) return bin[1]!;
  const inPackage = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
  return inPackage ? own(PACKAGE_TOOLS, inPackage) ?? inPackage : null;
}

const isTold = (name: string): boolean => HANDLERS.has(name) || toolHandler(name) !== null;

const NODE: Handler = async (guard, args, place) => {
  if (args.some(word => word.literal && /^--watch(?:-|=|$)/.test(word.text))) return guard.note(check('watch'));
  if (args.some(word => word.text === '--test')) return namedTests(guard, args, NODE_FLAGS, place);
  const script = args.find(word => !isFlag(word));
  const tool = script?.literal ? toolInNodeModules(script.text) : null;
  if (tool && isTold(tool)) return guard.run([literalWord(tool), ...args.slice(args.indexOf(script!) + 1)], place);
  guard.note(OPAQUE);
};

const TSX: Handler = async (guard, args, place) => {
  if (args[0]?.text === 'watch') return guard.note(check('watch'));
  if (args.some(word => word.text === '--test')) return namedTests(guard, args, NODE_FLAGS, place);
  guard.note(OPAQUE);
};

const PYTHON_VALUES = new Set(['-X', '-W']);
/* -m and -c may stand in one word with python's other short flags, and with what they carry. */
const PYTHON_RUNS = /^-[bBdEiIOPqRsSuvVx]*([mc])(.*)$/;

type PythonModule = { module: Word | undefined; rest: Word[] };
function pythonModule(args: Word[]): PythonModule | null {
  for (let at = 0; isFlag(args[at]); at += PYTHON_VALUES.has(args[at]!.text) ? 2 : 1) {
    const runs = PYTHON_RUNS.exec(args[at]!.text);
    if (runs) return runs[1] === 'm' ? moduleAt(runs[2]!, args, at) : null;
  }
  return null;
}

const moduleAt = (attached: string, args: Word[], at: number): PythonModule =>
  attached ? { module: literalWord(attached), rest: args.slice(at + 1) } : { module: args[at + 1], rest: args.slice(at + 2) };

const PYTHON_HANDLER: Handler = async (guard, args, place) => {
  const called = pythonModule(args);
  if (called?.module?.literal && isTold(called.module.text)) return guard.run([literalWord(called.module.text), ...called.rest], place);
  guard.note(OPAQUE);
};

const PACMAN: Handler = (guard, args) => {
  guard.note(args.some(word => word.literal && /^-S/.test(word.text)) ? dependency() : RECOGNIZED);
  return Promise.resolve();
};

/* npx and its like may run an installed tool or fetch one first. */
type ExecCall = { tool: Word | null; rest: Word[]; noInstall: boolean; fetches: boolean; call: Word | null };
const EXEC_NO_INSTALL = new Set(['--no-install', '--no']);
const EXEC_PACKAGE = new Set(['-p', '--package']);
const EXEC_CALL = new Set(['-c', '--call']);
const EXEC_VALUES = new Set([...EXEC_PACKAGE, ...EXEC_CALL, '--cache', '--registry', '--userconfig', '--loglevel']);

function readExec(args: Word[]): ExecCall {
  const exec: ExecCall = { tool: null, rest: [], noInstall: false, fetches: false, call: null };
  let at = 0;
  while (at < args.length) {
    const word = args[at]!;
    if (word.text === '--') return { ...exec, tool: args[at + 1] ?? null, rest: args.slice(at + 2) };
    if (!isFlag(word)) return { ...exec, tool: word, rest: args.slice(at + 1) };
    at = afterExecFlag(exec, args, at);
  }
  return exec;
}

function afterExecFlag(exec: ExecCall, args: Word[], at: number): number {
  const { name, value, after } = flagAt(args, at);
  if (EXEC_NO_INSTALL.has(name)) exec.noInstall = true;
  if (EXEC_PACKAGE.has(name)) exec.fetches = true;
  if (EXEC_CALL.has(name)) exec.call = value;
  return EXEC_VALUES.has(name) ? after : at + 1;
}

async function runExec(guard: Guard, args: Word[], place: Place, mayFetch: boolean): Promise<void> {
  const { tool, rest, noInstall, fetches, call } = readExec(args);
  if (call) return runExecText(guard, call, place);
  if (fetches) guard.note(dependency('implicit_install'));
  if (!tool) return guard.note(RECOGNIZED);
  if (!tool.literal) return guard.note(unavailable('dynamic_check'));
  if (mayFetch && !noInstall && (await wouldFetch(guard, tool.text, place))) guard.note(dependency('implicit_install'));
  await guard.run([literalWord(tool.text.replace(/(@[^/]+)$/, '')), ...rest], place);
}

const runExecText = (guard: Guard, call: Word, place: Place): Promise<void> => (call.literal ? guard.shellText(call.text, place) : Promise.resolve(guard.note(unavailable('dynamic_check'))));
const wouldFetch = async (guard: Guard, tool: string, place: Place): Promise<boolean> => tool.slice(1).includes('@') || !(await guard.localBin(tool, place));

const NPX: Handler = (guard, args, place) => runExec(guard, args, place, true);

/* A package manager's call: where it works, whether over many packages, and its first word. workspaces: what npm's -w named,
   a folder or a package's name; every: npm's --workspaces; withRoot: the root beside them; ifPresent: a package without the
   script is passed over; unclear: a switch of these whose value cannot be read. */
type ManagerCall = { sub: Word | null; rest: Word[]; dir: Word | null; workspaces: Word[]; every: boolean; withRoot: boolean; ifPresent: boolean; unclear: boolean; many: boolean; atRoot: boolean };
const DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const WORKSPACE_FLAGS = new Set(['-w', '--workspace']);
const MANY_FLAGS = new Set(['-ws', '--workspaces', '-r', '--recursive', '--filter', '-F', '--include-workspace-root', '-A', '--all']);
const VALUE_FLAGS = new Set([...DIR_FLAGS, '--filter', '-F', '--loglevel', '--registry', '--userconfig', '--cache', '--reporter', '--store-dir']);

function afterManagerFlag(call: ManagerCall, args: Word[], at: number, workspaces: boolean): number {
  const switched = workspaces ? afterSwitch(call, args, at) : null;
  if (switched !== null) return switched;
  const { name, value, after } = flagAt(args, at);
  noteManagerFlag(call, name, value, workspaces);
  return VALUE_FLAGS.has(name) || (workspaces && WORKSPACE_FLAGS.has(name)) ? after : at + 1;
}

/* -w is a workspace to npm, and the root of them all to pnpm. */
function noteManagerFlag(call: ManagerCall, name: string, value: Word | null, workspaces: boolean): void {
  if (MANY_FLAGS.has(name)) call.many = true;
  if (DIR_FLAGS.has(name)) call.dir = value;
  if (!WORKSPACE_FLAGS.has(name)) return;
  if (workspaces) call.workspaces.push(value ?? unknownWord());
  else if (name === '-w') call.atRoot = true;
}

/* npm runs a script in every workspace it is given, the root too when asked, and only where the script is with --if-present. */
type Switch = 'every' | 'withRoot' | 'ifPresent';
const NPM_SWITCHES: Readonly<Record<string, Switch>> = { '-ws': 'every', '--workspaces': 'every', '--include-workspace-root': 'withRoot', '--if-present': 'ifPresent' };

/* npm reads a switch alone as on, takes the true or false written in its own word or in the next one, and reads the opposite
   behind --no-. The last one written counts. Any other value npm may read in its own way, so the call cannot be told. */
function afterSwitch(call: ManagerCall, args: Word[], at: number): number | null {
  const text = args[at]!.text;
  const name = flagName(text);
  const negated = name.startsWith('--no-');
  const field = own(NPM_SWITCHES, negated ? `--${name.slice('--no-'.length)}` : name);
  if (!field) return null;
  const next = args[at + 1];
  const nextTells = next !== undefined && (!next.literal || next.text === 'true' || next.text === 'false');
  const written = text.length > name.length ? literalWord(text.slice(name.length + 1)) : nextTells ? next : null;
  const value = written === null ? true : written.literal && (written.text === 'true' || written.text === 'false') ? written.text === 'true' : null;
  if (value === null) call.unclear = true;
  else call[field] = value !== negated;
  return written !== null && text.length === name.length ? at + 2 : at + 1;
}

function readManager(args: Word[], workspaces: boolean): ManagerCall {
  const call: ManagerCall = { sub: null, rest: [], dir: null, workspaces: [], every: false, withRoot: false, ifPresent: false, unclear: false, many: false, atRoot: false };
  let at = 0;
  while (at < args.length && isFlag(args[at])) at = afterManagerFlag(call, args, at, workspaces);
  call.sub = args[at] ?? null;
  call.rest = args.slice(at + 1);
  return call;
}

type Manager = {
  deps: ReadonlySet<string>; scripts: ReadonlySet<string>; named: ReadonlySet<string>; execs: ReadonlySet<string>; reads: ReadonlySet<string>;
  /* Words that fetch a package only to run it. */
  fetchers: ReadonlySet<string>;
  /* Words that work over more than one package. */
  many: ReadonlySet<string>;
  bareInstalls: boolean;
  /* npm reads a flag after a script's name as its own; the others hand it to the script. */
  keepsFlags: boolean;
  workspaces: boolean;
  /* Any other word is a script's name. */
  anyWordIsScript: boolean;
  execFetches: boolean;
};

const words = (...list: string[]): ReadonlySet<string> => new Set(list);
const NPM: Manager = {
  deps: words('install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit', 'update', 'up', 'upgrade', 'udpate', 'rebuild', 'rb', 'dedupe', 'ddp', 'link', 'ln', 'uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'prune', 'init', 'create', 'innit'),
  scripts: words('run', 'run-script', 'rum', 'urn'), named: words('test', 'tst', 't', 'start', 'stop', 'restart'), execs: words('exec', 'x'), fetchers: words(),
  reads: words('view', 'v', 'info', 'show', 'ls', 'list', 'll', 'la', 'outdated', 'config', 'c', 'get', 'help', 'root', 'bin', 'whoami', 'ping', 'search', 'find', 'docs', 'repo', 'bugs', 'explain', 'why', 'fund', 'cache', 'audit', 'prefix'),
  many: words(), bareInstalls: false, keepsFlags: true, workspaces: true, anyWordIsScript: false, execFetches: true,
};
const PNPM: Manager = {
  deps: words('install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'un', 'uninstall', 'unlink', 'link', 'ln', 'import', 'fetch', 'rebuild', 'rb', 'dedupe', 'prune', 'install-test', 'it', 'create', 'init'),
  scripts: words('run', 'run-script'), named: words('test', 't', 'tst', 'start'), execs: words('exec'), fetchers: words('dlx'),
  reads: words('list', 'ls', 'll', 'la', 'outdated', 'why', 'view', 'config', 'root', 'bin', 'help', 'audit'),
  many: words(), bareInstalls: false, keepsFlags: false, workspaces: false, anyWordIsScript: true, execFetches: false,
};
const YARN: Manager = {
  deps: words('install', 'add', 'up', 'upgrade', 'upgrade-interactive', 'dedupe', 'remove', 'link', 'unlink', 'import', 'rebuild', 'create', 'init'),
  scripts: words('run'), named: words('test', 'start'), execs: words('exec'), fetchers: words('dlx'),
  reads: words('info', 'why', 'list', 'config', 'bin', 'help', 'audit'),
  many: words('workspaces', 'workspace'), bareInstalls: true, keepsFlags: false, workspaces: false, anyWordIsScript: true, execFetches: false,
};
const BUN: Manager = {
  deps: words('install', 'i', 'add', 'a', 'update', 'remove', 'rm', 'link', 'unlink', 'create', 'init'),
  scripts: words('run'), named: words(), execs: words('x'), fetchers: words(),
  reads: words('pm', 'outdated', 'help'),
  many: words(), bareInstalls: false, keepsFlags: false, workspaces: false, anyWordIsScript: true, execFetches: true,
};

/* Words after a script's name that reach the script. Past --, always. */
/* The words a script gets. npm reads a flag after the script's name as its own, so a workspace or folder named there is where the
   script runs; the other managers hand every word before -- to the script. */
function forwardedWords(manager: Manager, rest: Word[], call: ManagerCall): Word[] {
  const dashes = rest.findIndex(word => word.text === '--');
  const before = dashes < 0 ? rest : rest.slice(0, dashes);
  const after = dashes < 0 ? [] : rest.slice(dashes + 1);
  if (!manager.keepsFlags) {
    if (before.some(word => MANY_FLAGS.has(flagName(word.text)))) call.many = true;
    return [...before, ...after];
  }
  const kept: Word[] = [];
  for (let at = 0; at < before.length; ) {
    if (isFlag(before[at])) at = afterManagerFlag(call, before, at, manager.workspaces);
    else kept.push(before[at++]!);
  }
  return [...kept, ...after];
}

/* The folder a flag names is that folder or nothing. With no flag the nearest manifest counts, as npm finds it. */
async function namedFolder(guard: Guard, call: ManagerCall, place: Place): Promise<string | null> {
  if (call.atRoot) return guard.projectRoot(place.cwd);
  return call.dir?.literal && place.cwd !== null ? resolve(place.cwd, call.dir.text) : null;
}

async function scriptsFolder(guard: Guard, call: ManagerCall, place: Place): Promise<string | null> {
  if (!call.atRoot && !call.dir) return place.cwd;
  const folder = await namedFolder(guard, call, place);
  return folder !== null && (await guard.hasManifest(folder)) ? folder : null;
}

/* What npm's -w names, as npm reads it: a workspace by its package name, by its folder, or every workspace under a folder,
   the folder taken from where the command stands. */
async function workspaceFolder(guard: Guard, word: Word, root: string, cwd: string | null): Promise<string[] | null> {
  if (!word.literal) return null;
  const listed = await guard.workspaces(root);
  const named = listed?.find(item => item.name === word.text);
  if (named) return [named.folder];
  const folder = resolve(cwd ?? root, word.text);
  if (leavesFolder(relative(root, folder))) return null;
  if (!listed) return (await guard.hasManifest(folder)) ? [folder] : null;
  const under = listed.filter(item => item.folder === folder || !leavesFolder(relative(folder, item.folder))).map(item => item.folder);
  return under.length ? under : null;
}

/* Every folder a workspace call runs its script in, or null when one cannot be found. */
async function workspaceFolders(guard: Guard, call: ManagerCall, cwd: string | null): Promise<string[] | null> {
  const root = await guard.projectRoot(cwd);
  const named = call.every ? ((await guard.workspaces(root))?.map(item => item.folder) ?? null) : await namedWorkspaces(guard, call.workspaces, root, cwd);
  return named && [...new Set([...(call.withRoot ? [root] : []), ...named])];
}

async function namedWorkspaces(guard: Guard, words: Word[], root: string, cwd: string | null): Promise<string[] | null> {
  const folders: string[] = [];
  for (const word of words) {
    const found = await workspaceFolder(guard, word, root, cwd);
    if (found === null) return null;
    folders.push(...found);
  }
  return folders;
}

/* A script npm runs in workspaces is told in each of them: the call is refused when any of them is. */
async function workspaceScripts(guard: Guard, call: ManagerCall, name: string, forwarded: Word[], place: Place): Promise<void> {
  const folders = await workspaceFolders(guard, call, place.cwd);
  if (!folders) return guard.note(unavailable(guard.overRead() ? 'over_budget' : 'unresolved_script'));
  for (const folder of folders) {
    if (call.ifPresent && !(await guard.hasScript(folder, name))) continue;
    await guard.packageScript(name, forwarded, folder, place);
  }
}

async function runScriptCall(manager: Manager, guard: Guard, call: ManagerCall, name: string, rest: Word[], place: Place): Promise<void> {
  const scoped: ManagerCall = { ...call, workspaces: [...call.workspaces] };
  const forwarded = forwardedWords(manager, rest, scoped);
  if (scoped.many) return guard.note(check('package_scope'));
  if (scoped.unclear) return guard.note(unavailable('dynamic_check'));
  if (scoped.every || scoped.workspaces.length) return workspaceScripts(guard, scoped, name, forwarded, place);
  await guard.packageScript(name, forwarded, await scriptsFolder(guard, scoped, place), place);
}

async function useManager(manager: Manager, guard: Guard, args: Word[], place: Place): Promise<void> {
  const call = readManager(args, manager.workspaces);
  if (call.many) return guard.note(check('package_scope'));
  const { sub, rest } = call;
  if (!sub) return guard.note(manager.bareInstalls ? dependency() : RECOGNIZED);
  if (!sub.literal) return guard.note(unavailable('dynamic_check'));
  const known = managerAction(manager, sub.text);
  await known(manager, guard, call, sub.text, rest, place);
}

type ManagerAction = (manager: Manager, guard: Guard, call: ManagerCall, sub: string, rest: Word[], place: Place) => Promise<void>;

const noteAction = (finding: Finding): ManagerAction => (_manager, guard) => Promise.resolve(guard.note(finding));
const scriptAction: ManagerAction = async (manager, guard, call, _sub, rest, place) => {
  const name = rest.find(word => !isFlag(word));
  if (!name) return guard.note(RECOGNIZED);
  if (!name.literal) return guard.note(unavailable('dynamic_check'));
  await runScriptCall(manager, guard, call, name.text, rest.filter(word => word !== name), place);
};
const namedAction: ManagerAction = (manager, guard, call, sub, rest, place) => runScriptCall(manager, guard, call, own(SCRIPT_NAMES, sub) ?? sub, rest, place);
/* A program run over every workspace is told in none of them. */
const execAction: ManagerAction = async (manager, guard, call, _sub, rest, place) => {
  if (call.every || call.unclear) return guard.note(call.unclear ? unavailable('dynamic_check') : check('package_scope'));
  await runExec(guard, rest, place, manager.execFetches);
};

const fetchAction: ManagerAction = async (manager, guard, call, sub, rest, place) => {
  guard.note(dependency('implicit_install'));
  await execAction(manager, guard, call, sub, rest, place);
};

const INSTALL_TEST = new Set(['install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit']);
const installTestAction: ManagerAction = async (manager, guard, call, _sub, rest, place) => {
  guard.note(dependency());
  await runScriptCall(manager, guard, call, 'test', rest, place);
};

const SCRIPT_NAMES: Readonly<Record<string, string>> = { t: 'test', tst: 'test' };

function managerAction(manager: Manager, sub: string): ManagerAction {
  if (manager.deps.has(sub) && INSTALL_TEST.has(sub)) return installTestAction;
  if (manager.deps.has(sub)) return noteAction(dependency());
  if (manager.fetchers.has(sub)) return fetchAction;
  if (manager.many.has(sub)) return noteAction(check('package_scope'));
  if (manager.scripts.has(sub)) return scriptAction;
  if (manager.named.has(sub)) return namedAction;
  if (manager.execs.has(sub)) return execAction;
  if (manager.reads.has(sub)) return noteAction(RECOGNIZED);
  return manager.anyWordIsScript ? namedAction : noteAction(unavailable('package_boundary'));
}

const managerHandler = (manager: Manager): Handler => (guard, args, place) => useManager(manager, guard, args, place);

/* bun's own test runner and bundler come before anything named so in a manifest. */
const BUN_HANDLER: Handler = async (guard, args, place) => {
  const first = args.find(word => !isFlag(word))?.text;
  if (first && /\.[cm]?[jt]sx?$/.test(first)) return guard.note(OPAQUE);
  if (first === 'test') return namedTests(guard, args.slice(args.findIndex(word => word.text === 'test') + 1), { '--coverage': false, '-t': true, '--test-name-pattern': true, '--timeout': true, '--bail': false }, place);
  if (first === 'build') return guard.note(check('build'));
  await useManager(BUN, guard, args, place);
};

const DENO: Handler = (guard, args, place) => {
  if (args[0]?.text === 'test') return namedTests(guard, args.slice(1), { '--allow-all': false, '-A': false, '--no-check': false, '--coverage': true }, place);
  return toolHandler('deno')!(guard, args, place);
};

const BUSYBOX: Handler = (guard, args, place) => guard.run(args, place);

/* A named part of another language's suite: words a runner reads as one bounded selection, all literal. allowed: its flags, each
   saying whether a value follows; select: the flag that names the part, whose value has no wildcard. */
type PartRule = { allowed: Flags; select: readonly string[] };
type Part = { flags: Map<string, Word[]>; words: Word[]; after: Word[] };

/* The flags, other words and words past -- of a runner's call, or null when a flag is not one it allows or a word is not literal. */
function readPart(args: Word[], allowed: Flags): Part | null {
  const part: Part = { flags: new Map(), words: [], after: [] };
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!;
    if (!word.literal) return null;
    if (word.text === '--') return { ...part, after: args.slice(at + 1) };
    if (!isFlag(word)) { part.words.push(word); continue; }
    const name = flagName(word.text);
    if (!Object.hasOwn(allowed, name)) return null;
    const value = word.text.length > name.length ? literalWord(word.text.slice(name.length + 1)) : allowed[name] ? args[++at] : literalWord('');
    if (!value?.literal || (allowed[name] && isFlag(value))) return null;
    part.flags.set(name, [...(part.flags.get(name) ?? []), value]);
  }
  return part;
}

const WILDCARD = /[*?[\]{}$`]/;
/* Some flag of the rule names a part, and none of its names has a wildcard. */
const selects = (part: Part, rule: PartRule): boolean => {
  const named = rule.select.flatMap(flag => part.flags.get(flag) ?? []);
  return named.some(value => value.text.length > 0) && named.every(value => !WILDCARD.test(value.text));
};

/* A part runs here only as a selection the runner bounds itself; anything else stays the finding it was. */
async function namedPart(guard: Guard, place: Place, bounded: boolean, otherwise: () => Promise<void> | void): Promise<void> {
  if (bounded && !place.tainted && !place.loop) return guard.note({ kind: 'test_file' });
  await otherwise();
}

const GO_TEST: Flags = { '-run': true, '-v': false, '-count': true, '-race': false, '-timeout': true, '-short': false, '-failfast': false, '-cover': false, '-coverprofile': true, '-json': false };
/* go test of package folders of the workspace, never a pattern of them. */
const GO: Handler = async (guard, args, place) => {
  if (args[0]?.text !== 'test') return toolHandler('go')!(guard, args, place);
  const part = readPart(args.slice(1), GO_TEST);
  const folders = part && part.words.length > 0 && part.words.every(word => !word.text.includes('...') && /^\.\.?(?:\/|$)/.test(word.text))
    ? await Promise.all(part.words.map(word => guard.regularFolder(word, place))) : [false];
  await namedPart(guard, place, Boolean(part && !part.after.length) && folders.every(Boolean), () => toolHandler('go')!(guard, args, place));
};

const CARGO_TEST: PartRule = { allowed: { '-p': true, '--package': true, '--lib': false, '--test': true, '--release': false, '-q': false, '--quiet': false, '-v': false, '--no-fail-fast': false, '--features': true }, select: ['-p', '--package'] };
/* cargo test of named packages, with one test name to filter by if it likes. */
const CARGO: Handler = async (guard, args, place) => {
  if (!['test', 't'].includes(args[0]?.text ?? '')) return toolHandler('cargo')!(guard, args, place);
  const part = readPart(args.slice(1), CARGO_TEST.allowed);
  await namedPart(guard, place, Boolean(part && selects(part, CARGO_TEST) && part.words.length <= 1), () => toolHandler('cargo')!(guard, args, place));
};

const DOTNET_TEST: PartRule = { allowed: { '--filter': true, '-c': true, '--configuration': true, '--no-build': false, '--no-restore': false, '-v': true, '--verbosity': true, '--logger': true, '-f': true, '--framework': true }, select: ['--filter'] };
/* dotnet test with a filter, of one project file of the workspace at most. */
const DOTNET: Handler = async (guard, args, place) => {
  if (args[0]?.text !== 'test') return toolHandler('dotnet')!(guard, args, place);
  const part = readPart(args.slice(1), DOTNET_TEST.allowed);
  const project = part && part.words.length === 1 ? await guard.regularFile(part.words[0]!, place) : part?.words.length === 0;
  await namedPart(guard, place, Boolean(part && selects(part, DOTNET_TEST) && project && !part.after.length), () => toolHandler('dotnet')!(guard, args, place));
};

const MAVEN_TEST: PartRule = { allowed: { '-Dtest': true, '-DfailIfNoTests': true, '-Dsurefire.failIfNoSpecifiedTests': true, '-q': false, '--quiet': false, '-o': false, '--offline': false, '-B': false, '--batch-mode': false, '-pl': true, '--projects': true }, select: ['-Dtest'] };
/* mvn of the test goal alone, with -Dtest naming its classes. */
const MAVEN: Handler = async (guard, args, place) => {
  const part = readPart(args, MAVEN_TEST.allowed);
  await namedPart(guard, place, Boolean(part && selects(part, MAVEN_TEST) && part.words.length === 1 && part.words[0]!.text === 'test' && !part.after.length), () => toolHandler('mvn')!(guard, args, place));
};

const GRADLE_TEST: PartRule = { allowed: { '--tests': true, '-q': false, '--quiet': false, '-i': false, '--info': false, '--offline': false, '--no-daemon': false, '--console': true }, select: ['--tests'] };
/* gradle of test tasks alone, with --tests naming what they run. */
const GRADLE: Handler = async (guard, args, place) => {
  const part = readPart(args, GRADLE_TEST.allowed);
  const tasks = part?.words ?? [];
  await namedPart(guard, place, Boolean(part && selects(part, GRADLE_TEST) && tasks.length > 0 && tasks.every(word => /^(?::[\w.-]+)*:?test$/.test(word.text)) && !part.after.length), () => toolHandler('gradle')!(guard, args, place));
};

const HANDLERS = new Map<string, Handler>([
  ...Object.entries(WRAPPERS).map(([name, wrapper]): [string, Handler] => [name, wrapperHandler(wrapper)]),
  ...['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash'].map((name): [string, Handler] => [name, SHELL]),
  ...['chromium', 'chromium-browser', 'chrome', 'google-chrome', 'google-chrome-stable', 'chrome-headless-shell', 'headless_shell'].map((name): [string, Handler] => [name, BROWSER]),
  ['eval', EVAL], ['source', SOURCE], ['.', SOURCE], ['cd', CD], ['pushd', CD], ['popd', CD], ['export', EXPORT], ['xargs', XARGS], ['parallel', XARGS], ['find', FIND], ['busybox', BUSYBOX],
  ...['mocha', 'ava', 'tap', 'rspec', 'phpunit', 'behave', 'nosetests', 'jasmine', 'tape', 'cucumber'].map((name): [string, Handler] => [name, JEST]),
  ['deno', DENO], ['go', GO], ['cargo', CARGO], ['dotnet', DOTNET], ['mvn', MAVEN], ['mvnw', MAVEN], ['gradle', GRADLE], ['gradlew', GRADLE],
  ['c8', COVERAGE], ['nyc', COVERAGE], ['coverage', COVERAGE],
  ['vitest', VITEST], ['jest', JEST], ['pytest', PYTEST], ['py.test', PYTEST], ['playwright', PLAYWRIGHT], ['node', NODE], ['nodejs', NODE], ['tsx', TSX], ['python', PYTHON_HANDLER], ['pacman', PACMAN],
  ['npx', NPX], ['bunx', NPX], ['npm', managerHandler(NPM)], ['pnpm', managerHandler(PNPM)], ['yarn', managerHandler(YARN)], ['bun', BUN_HANDLER],
]);

/* Why a command is refused, by what it is: never its own text, which can hold a secret, and which the program's call keeps. */
const CATEGORY_WORDS: Readonly<Partial<Record<Category, string>>> = {
  test_scope: 'This test run does not name only regular test files.',
  watch: 'Watch modes do not end.',
  task_runner: 'This task runner can run the whole suite.',
  dynamic_check: 'What this check selects cannot be read before it runs.',
  unresolved_script: 'This package script cannot be read before it runs.',
  missing_script: 'This package has no such script: read its package.json for the scripts it has.',
  script_cycle: 'These scripts call each other.',
  package_scope: 'This runs over more than one package.',
  package_boundary: 'What this package command does cannot be told here.',
  malformed: 'This command cannot be read before it runs.',
  over_budget: 'This command is too long or too deep to read before it runs.',
  guard_failed: 'The check of this command failed, so it did not run.',
};

export function refusalText(denial: CommandDenial): string {
  const why = CATEGORY_WORDS[denial.category as Category] ?? 'This check cannot run here.';
  return `${REFUSAL}\nHornhoof stopped this command before it started. ${why} A whole test suite runs through run_tests once per release, on its release branch. Name the test files of your change to run them here. A refusal is not a result.`;
}

function refusal(found: readonly Finding[], kinds: readonly ('check' | 'unavailable')[]): CommandDenial | null {
  const codes = { check: 'whole_suite_local', unavailable: 'command_guard_unavailable' } as const;
  for (const kind of kinds) {
    const finding = found.find(item => item.kind === kind) as { category: Category } | undefined;
    if (finding) return { allow: false, code: codes[kind], category: finding.category };
  }
  return null;
}

const coverageOf = (found: readonly Finding[]): CommandCoverage => (found.some(item => item.kind === 'ordinary' && item.coverage === 'opaque') ? 'opaque' : 'recognized');
const has = (found: readonly Finding[], kind: Finding['kind']): boolean => found.some(item => item.kind === kind);

function agentVerdict(found: readonly Finding[]): AgentCommandVerdict {
  const local = found.filter(item => item.kind !== 'check' || !['build', 'types', 'lint', 'format', 'coverage', 'quality', 'mutation'].includes(item.category));
  const denial = refusal(local, ['check', 'unavailable']);
  if (denial) return denial;
  const coverage = coverageOf(found);
  if (has(found, 'test_file')) return { allow: true, kind: 'test_files', coverage };
  return { allow: true, kind: has(found, 'screenshot') ? 'lightweight_screenshot' : 'ordinary', coverage };
}

function workVerdict(found: readonly Finding[]): WorkCommandVerdict {
  const denial = refusal(found, ['check', 'unavailable']);
  if (denial) return denial;
  if (has(found, 'test_file')) return { allow: false, code: 'whole_suite_local', category: 'test_scope' };
  const coverage = coverageOf(found);
  if (has(found, 'dependency')) return { allow: true, kind: 'dependency_preparation', coverage };
  return { allow: true, kind: has(found, 'screenshot') ? 'lightweight_screenshot' : 'ordinary', coverage };
}

const bytesOf = (command: string | readonly string[]): number =>
  typeof command === 'string' ? Buffer.byteLength(command) : command.reduce((sum, word) => sum + Buffer.byteLength(word) + 1, 0);

async function examine({ command, cwd, workspaceRoot }: CommandInput, files: CommandFiles): Promise<Finding[]> {
  if (bytesOf(command) > COMMAND_LIMITS.commandBytes) return [unavailable('over_budget')];
  const realRoot = await files.realpath(workspaceRoot);
  const guard = new Guard(files, workspaceRoot, realRoot);
  const place: Place = { cwd: isAbsolute(cwd) ? cwd : null, loop: false, boundary: false, tainted: false, depth: 0, chain: [], stdin: null };
  if (typeof command === 'string') await examineText(guard, command, place);
  else await examineWords(guard, command, place);
  return guard.found;
}

async function examineText(guard: Guard, command: string, place: Place): Promise<void> {
  const read = readShell(command);
  if ('category' in read) return guard.note(unavailable(read.category));
  await guard.steps(read.steps, place);
}

async function examineWords(guard: Guard, command: readonly string[], place: Place): Promise<void> {
  if (!command.length || command.some(word => word.includes('\0'))) return guard.note(unavailable('malformed'));
  await guard.run(command.map(word => ({ ...literalWord(word), assign: ASSIGNMENT.test(word) })), place);
}

/* The call of whoever asked to run a command in an agent's terminal, or through an agent's own check command. */
export async function classifyAgentCommand(input: CommandInput, files: CommandFiles = localCommandFiles): Promise<AgentCommandVerdict> {
  try {
    return agentVerdict(await examine(input, files));
  } catch {
    return { allow: false, code: 'command_guard_unavailable', category: 'guard_failed' };
  }
}

/* The node's own call before a work part's first stage: dependencies alone may be prepared under work rights, any check goes to run_tests. */
export async function classifyRunWork(input: CommandInput, files: CommandFiles = localCommandFiles): Promise<WorkCommandVerdict> {
  try {
    return workVerdict(await examine(input, files));
  } catch {
    return { allow: false, code: 'command_guard_unavailable', category: 'guard_failed' };
  }
}
