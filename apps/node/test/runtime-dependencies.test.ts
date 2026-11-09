import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };

/* The package a bare specifier names: its scope and name, without a path inside it. */
const packageOf = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const builtin = (specifier: string): boolean => specifier.startsWith('node:') || builtinModules.includes(packageOf(specifier));
const bare = (specifier: string): boolean => !specifier.startsWith('.') && !specifier.startsWith('/') && !builtin(specifier);

/* Whether an import brings code at run time: TypeScript drops one that only names types. */
function bringsCode(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  return !bindings || ts.isNamespaceImport(bindings) || bindings.elements.length === 0 || bindings.elements.some(element => !element.isTypeOnly);
}

/* The packages a source file loads as it runs, statically or with import(). */
function runtimeImports(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && bringsCode(node)) found.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter(bare).map(packageOf);
}

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
  .map(entry => join(entry.parentPath, entry.name));

describe("the node's production dependencies", () => {
  it('hold every package the code of the node loads as it runs, as the image installs only those', () => {
    const missing = sources(join(root, 'src')).flatMap(file => runtimeImports(file)
      .filter(name => !(name in (manifest.dependencies ?? {})))
      .map(name => `${relative(root, file)} loads ${name}`));
    expect(missing).toEqual([]);
  });

  it('sees a dynamic import and leaves out an import of types alone', () => {
    const text = [
      "import plain from 'plain-pkg';",
      "import type { OnlyType } from 'type-only-pkg';",
      "import { type NamedType } from 'named-type-pkg';",
      "import { type MixedType, value } from 'mixed-pkg';",
      "import * as scoped from '@scope/pkg/sub/path';",
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'path';",
      "import { local } from './local.js';",
      "export { thing } from 'export-pkg';",
      "export type { ExportedType } from 'export-type-pkg';",
      "export const later = () => import('dynamic-pkg');",
    ].join('\n');
    expect(runtimeImports('fixture.ts', text).sort()).toEqual(['@scope/pkg', 'dynamic-pkg', 'export-pkg', 'mixed-pkg', 'plain-pkg']);
  });
});
