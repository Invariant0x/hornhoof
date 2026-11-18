import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function valueGraph(texts) {
  return new Map([...texts].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const edges = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : statement;
      if (clause?.isTypeOnly) continue;
      const names = ts.isImportDeclaration(statement) ? clause?.namedBindings : statement.exportClause;
      if (names && (ts.isNamedImports(names) || ts.isNamedExports(names)) && names.elements.length && names.elements.every(name => name.isTypeOnly) && !clause?.name) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), specifier.text)).replace(/\.js$/, '.ts');
      if (texts.has(target)) edges.add(target);
    }
    return [path, [...edges].sort()];
  }));
}

export function cyclicGroups(graph) {
  const seen = new Map(), low = new Map(), active = new Set(), stack = [], groups = [];
  function visit(path) {
    seen.set(path, seen.size);
    low.set(path, seen.get(path));
    stack.push(path);
    active.add(path);
    for (const target of graph.get(path) ?? []) {
      if (!seen.has(target)) {
        visit(target);
        low.set(path, Math.min(low.get(path), low.get(target)));
      } else if (active.has(target)) low.set(path, Math.min(low.get(path), seen.get(target)));
    }
    if (low.get(path) !== seen.get(path)) return;
    const group = [];
    let last;
    do {
      last = stack.pop();
      active.delete(last);
      group.push(last);
    } while (last !== path);
    if (group.length > 1 || graph.get(path)?.includes(path)) groups.push(group.sort());
  }
  for (const path of [...graph.keys()].sort()) if (!seen.has(path)) visit(path);
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}

export function serverGraph(root) {
  const directory = join(root, 'apps/server/src');
  const files = readdirSync(directory, { recursive: true }).filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts')).sort();
  return valueGraph(new Map(files.map(path => [path, readFileSync(join(directory, path), 'utf8')])));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const graph = serverGraph(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const groups = cyclicGroups(graph);
  process.stdout.write(JSON.stringify({ files: graph.size, edges: [...graph.values()].reduce((n, edges) => n + edges.length, 0), cyclicGroups: groups.length, largestGroup: Math.max(0, ...groups.map(group => group.length)), groups }, null, 2) + '\n');
}
