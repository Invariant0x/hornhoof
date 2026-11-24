import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LOCALES, PSEUDO_LOCALES } from '@hornhoof/protocol';

const SRC = resolve(process.cwd(), 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(resolve(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [resolve(dir, entry.name)] : []));
const FILES = walk(SRC).map(file => ({ path: relative(SRC, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }));

/* The pages that exist for developers and designers, served by the dev server and by tests and never by the product's
   build: they keep a copy of their own and are not people-facing. Nothing else may be listed here. */
const DEMO_PAGES = ['world/demo/main.tsx', 'world-packs/city-sim.tsx', 'world-packs/construction-demo.tsx', 'world-packs/gallery.tsx', 'world-packs/live-city.tsx'];

/* Words that are the same in every language: names of products and licences. */
const NAMES = new Set(['Hornhoof', 'hornhoof.org', 'Anthropic', 'OpenAI', 'MIT']);
const ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-placeholder', 'aria-roledescription']);
/* A path to a file, as a field shows one as its example, says the same in every language. */
const PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;
const readable = (text: string): boolean => {
  const bare = text.replace(/&\w+;/g, '').trim();
  return /\p{L}{2,}/u.test(bare) && !NAMES.has(bare) && !/^https?:\/\//.test(bare) && !PATH.test(bare);
};

/* Every text a person reads that a screen wrote into its own markup instead of taking it from a language file: text
   between tags, a string child, and the attributes a screen reader or a tooltip says aloud. */
function literals(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && readable(node.text)) found.push(node.text.trim());
    if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText()) && node.initializer && ts.isStringLiteral(node.initializer) && readable(node.initializer.text)) found.push(node.initializer.text);
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && readable(node.expression.text)) found.push(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no text of a screen outside the language files', () => {
  it('finds a literal text between tags, in a string child and in the attributes a person hears', () => {
    expect(literals('a.tsx', 'const a = <p title="Close the window">Hello there</p>;')).toEqual(['Close the window', 'Hello there']);
    expect(literals('a.tsx', "const a = <p>{'Hello there'}</p>;")).toEqual(['Hello there']);
    expect(literals('a.tsx', 'const a = <p title={t.close}>{t.hello}</p>;')).toEqual([]);
    expect(literals('a.tsx', 'const a = <p>Hornhoof</p>;')).toEqual([]);
    expect(literals('a.tsx', 'const a = <input placeholder=".github/workflows/release.yml" />;')).toEqual([]);
    expect(literals('a.tsx', 'const a = <input placeholder="Release workflow" />;')).toEqual(['Release workflow']);
  });

  it('holds on every screen: each text comes from the language of the person', () => {
    const wrong = FILES.filter(file => file.path.endsWith('.tsx') && !DEMO_PAGES.includes(file.path)).flatMap(file => literals(file.path, file.text).map(text => `${file.path}: ${text}`));
    expect(wrong).toEqual([]);
  });

  it('lists only demo pages that exist', () => {
    expect(DEMO_PAGES.filter(page => !FILES.some(file => file.path === page))).toEqual([]);
  });
});

/* Where a language's own words are kept: the language files of every domain. */
const LANGUAGE_FILES = /^i18n\/|^world\/pack-locales\/|^world-packs\/[^/]+\/locales\/|^world-packs\/viewer-locales\//;

/* A string of code written in a script other than Latin is a text in some language that sits outside its file. */
function otherScripts(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const letters = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Devanagari}]/u;
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const own = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text : '';
    if (own && letters.test(own)) found.push(own.trim().slice(0, 60));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no word of another script outside the language files', () => {
  it('finds a string or a text between tags written in Cyrillic', () => {
    expect(otherScripts('a.tsx', "const a = 'Привет'; const b = <p>Мир</p>; // комментарий")).toEqual(['Привет', 'Мир']);
    expect(otherScripts('a.ts', 'const a = `x ${1} Тест`;')).toEqual(['Тест']);
  });

  it('holds in every screen and module, the demo pages aside', () => {
    const wrong = FILES.filter(file => !LANGUAGE_FILES.test(file.path) && !DEMO_PAGES.includes(file.path)).flatMap(file => otherScripts(file.path, file.text).map(text => `${file.path}: ${text}`));
    expect(wrong).toEqual([]);
  });
});

/* A language is a file and a line of the registry: code that names one, or branches on it, has to be changed to add the next. */
describe('no code that names a language', () => {
  const ids = [...LOCALES, ...PSEUDO_LOCALES].map(locale => locale.id);
  const quoted = (id: string) => `['"\`]${id}['"\`]`;
  const name = `(?:${ids.map(quoted).join('|')})`;
  const branch = new RegExp(`[=!]==?\\s*${name}|${name}\\s*[=!]==?|case\\s+${name}\\s*:`);

  it('finds a comparison with a language and a case of one', () => {
    expect(branch.test("if (lang === 'ru') return 1;")).toBe(true);
    expect(branch.test("const x = 'en' !== language;")).toBe(true);
    expect(branch.test("switch (l) { case 'ru': break; }")).toBe(true);
    expect(branch.test("const only = isSourceLocale(language) ? 'en' : 'x';")).toBe(false);
  });

  it('compares no language with a name and switches on none', () => {
    const wrong = FILES.filter(file => !DEMO_PAGES.includes(file.path) && !file.path.startsWith('i18n/'))
      .flatMap(file => file.text.split('\n').map((line, at) => ({ path: file.path, at: at + 1, line })).filter(({ line }) => branch.test(line)))
      .map(({ path, at, line }) => `${path}:${at}: ${line.trim()}`);
    expect(wrong).toEqual([]);
  });

  it('keeps no text as a pair of two languages', () => {
    const pair = /\{\s*en:\s*['"`][^]*?,\s*ru:\s*['"`]/;
    const wrong = FILES.filter(file => !file.path.startsWith('i18n/') && pair.test(file.text)).map(file => file.path);
    expect(wrong).toEqual([]);
  });
});
