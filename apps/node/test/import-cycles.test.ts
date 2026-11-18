import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/* Only imports that load a module when this one loads: `import type` and all-type named imports load nothing. */
function valueSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return null;
    const named = clause?.namedBindings;
    if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)) return null;
    return (statement.moduleSpecifier as ts.StringLiteral).text;
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
    if (statement.isTypeOnly) return null;
    const named = statement.exportClause;
    if (named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)) return null;
    return (statement.moduleSpecifier as ts.StringLiteral).text;
  }
  return null;
}

/* Each source file of the node and the source files it loads by a relative value import. */
function valueImports(root: string): Map<string, string[]> {
  const files = sources(root);
  const known = new Set(files);
  const target = (from: string, spec: string) => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec).replace(/\.m?js$/, '');
    return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(path => known.has(path)) ?? null;
  };
  return new Map(files.map(file => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out = source.statements.map(valueSpecifier).flatMap(spec => (spec ? [target(file, spec)] : [])).filter((t): t is string => t !== null);
    return [relative(root, file), [...new Set(out)].map(t => relative(root, t))];
  }));
}

/* Groups of two or more files that load each other in a ring (strongly connected components, Tarjan). */
function cycleGroups(edges: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (file: string) => {
    index.set(file, next); low.set(file, next); next++;
    stack.push(file); onStack.add(file);
    for (const to of edges.get(file) ?? []) {
      if (!index.has(to)) { visit(to); low.set(file, Math.min(low.get(file)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(file, Math.min(low.get(file)!, index.get(to)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const group: string[] = [];
    let top: string;
    do { top = stack.pop()!; onStack.delete(top); group.push(top); } while (top !== file);
    if (group.length > 1) groups.push(group.sort());
  };
  for (const file of edges.keys()) if (!index.has(file)) visit(file);
  return groups;
}

describe('the node source', () => {
  it('finds a ring of imports and none in a chain', () => {
    expect(cycleGroups(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']], ['d.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(cycleGroups(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', []]]))).toEqual([]);
  });

  it('has no ring of value imports, so each module loads after everything it uses', () => {
    expect(cycleGroups(valueImports(SRC))).toEqual([]);
  });
});
