import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES, PSEUDO_LOCALES } from '@hornhoof/protocol';

const SRC = resolve(process.cwd(), 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(resolve(dir, entry.name)) : /\.ts$/.test(entry.name) ? [resolve(dir, entry.name)] : []));
const FILES = walk(SRC).map(file => ({ path: relative(SRC, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }));

/* A language is a file and a line of the registry: server code that names one, branches on it or keeps a text as a pair
   of two languages has to be changed to add the next. The files of the languages, locales/<id>.ts, are where words go. */
describe('no server code that names a language', () => {
  const ids = [...LOCALES, ...PSEUDO_LOCALES].map(locale => locale.id);
  const name = `(?:${ids.map(id => `['"\`]${id}['"\`]`).join('|')})`;
  const branch = new RegExp(`[=!]==?\\s*${name}|${name}\\s*[=!]==?|case\\s+${name}\\s*:`);

  it('compares no language with a name and switches on none', () => {
    const wrong = FILES.flatMap(file => file.text.split('\n').map((line, at) => ({ path: file.path, at: at + 1, line })).filter(({ line }) => branch.test(line))).map(({ path, at, line }) => `${path}:${at}: ${line.trim()}`);
    expect(wrong).toEqual([]);
  });

  it('keeps no text as a pair of two languages outside the language files', () => {
    const pair = /\{\s*en:\s*['"`][^]*?,\s*ru:\s*['"`]/;
    const wrong = FILES.filter(file => !/^locales\/|^modules\/world\/packs\/locales\//.test(file.path) && pair.test(file.text)).map(file => file.path);
    expect(wrong).toEqual([]);
  });

  it('names no language where a column or a schema takes the languages', () => {
    const wrong = FILES.filter(file => /enum:\s*\[\s*['"]en['"]/.test(file.text) || /z\.enum\(\[\s*['"]en['"]/.test(file.text)).map(file => file.path);
    expect(wrong).toEqual([]);
  });
});
