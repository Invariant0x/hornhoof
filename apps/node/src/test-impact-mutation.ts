import { posix } from 'node:path';
import ts from 'typescript';
import { RepositoryPath, type TestEnvironmentV1 } from '@hornhoof/protocol';
import type { FingerprintInput } from './test-fingerprint.js';

export interface MutationDelta { baseCommit: string; commit: string; changes: { path: string; ranges: [number, number][] }[] }
export interface MutationFunction { file: string; name: string; startLine: number; endLine: number; lines: number[]; tests: string[]; reason: 'changed_pure_function' }
export interface MutationSelection {
  version: 1; status: 'ready' | 'blocked'; baseCommit: string; commit: string;
  selected: MutationFunction[]; excluded: { file: string; name?: string; reason: string }[]; problems: { file?: string; code: string }[];
}
type Supported = Extract<TestEnvironmentV1['mutation'], { status: 'supported' }>;
type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Functions = Map<string, FunctionNode>;
type Graph = { closure(starts: string | string[]): Set<string> };
const FIXTURE = /(?:^|\/)(?:fixtures?|__fixtures__|test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;
const SHA = /^[a-f0-9]{40}$/;
const FORBIDDEN = new Set(['process', 'fetch', 'globalThis', 'window', 'document', 'console', 'Date', 'crypto', 'require', 'setTimeout', 'setInterval', 'WebSocket', 'XMLHttpRequest']);
const MATH = new Set(['abs', 'ceil', 'floor', 'round', 'trunc', 'min', 'max', 'sign', 'sqrt', 'pow']);
const validRange = ([start, count]: [number, number]): boolean => Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(count) && count > 0;
const validDelta = (delta: MutationDelta): boolean => SHA.test(delta.baseCommit) && SHA.test(delta.commit) && delta.changes.every(change => RepositoryPath.safeParse(change.path).success && change.ranges.every(validRange));

function parsed(input: FingerprintInput): Map<string, ts.SourceFile> {
  return new Map([...input.texts].map(([path, text]) => [path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)]));
}
function importedTypes(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  return Boolean(clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(item => item.isTypeOnly)));
}
function resolves(files: Map<string, ts.SourceFile>, from: string, specifier: string): boolean {
  const target = posix.join(posix.dirname(from), specifier), stem = target.replace(/\.[cm]?js$/, '');
  return [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '/index.ts', '/index.js'].map(extension => stem + extension)].some(path => files.has(path));
}
function unsafeImports(file: ts.SourceFile, files: Map<string, ts.SourceFile>): boolean {
  return file.statements.some(node => {
    if (ts.isImportDeclaration(node) && importedTypes(node)) return false;
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return ts.isImportEqualsDeclaration(node);
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return false;
    if (!node.moduleSpecifier) return false;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return true;
    const specifier = node.moduleSpecifier.text;
    return specifier.startsWith('.') ? !resolves(files, file.fileName, specifier) : !(specifier === 'vitest' && FIXTURE.test(file.fileName));
  });
}
function someNode(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  return predicate(node) || Boolean(ts.forEachChild(node, child => someNode(child, predicate)));
}
function unsafeJudge(path: string, files: Map<string, ts.SourceFile>, graph: Graph): boolean {
  return [...graph.closure(path)].some(file => {
    const node = files.get(file);
    return !node || /(?:^|\/)(?:fixtures?|__fixtures__)(?:\/|$)/.test(file) || unsafeImports(node, files)
      || someNode(node, child => ts.isIdentifier(child) && FORBIDDEN.has(child.text));
  });
}
function functionsOf(file: ts.SourceFile): Functions {
  const functions: Functions = new Map();
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer && (ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))) functions.set(item.name.text, item.initializer);
    }
  }
  return functions;
}
function constantNames(file: ts.SourceFile): Set<string> {
  return new Set(file.statements.filter(ts.isVariableStatement).filter(statement => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap(statement => statement.declarationList.declarations.filter(item => ts.isIdentifier(item.name) && item.initializer && (ts.isLiteralExpression(item.initializer) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(item.initializer.kind))).map(item => item.name.getText(file))));
}
function reference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !(ts.isPropertyAccessExpression(parent) && parent.name === node) && !(ts.isPropertyAssignment(parent) && parent.name === node)
    && !(ts.isVariableDeclaration(parent) && parent.name === node) && !(ts.isParameter(parent) && parent.name === node);
}
function safeCall(node: ts.CallExpression, names: Functions, constants: Set<string>, seen: Set<string>): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return names.has(callee.text) && pureFunction(callee.text, names, constants, seen);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Math' && MATH.has(callee.name.text);
}
function unsafeSyntax(node: ts.Node): boolean {
  if (ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node) || ts.isThrowStatement(node) || ts.isTaggedTemplateExpression(node)) return true;
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
}
function pureFunction(name: string, functions: Functions, constants: Set<string>, seen: Set<string> = new Set()): boolean {
  const node = functions.get(name)!;
  if (seen.has(name) || !node.body || ('asteriskToken' in node && node.asteriskToken) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const next = new Set([...seen, name]), locals = new Set([...constants, ...node.parameters.map(parameter => parameter.name.getText())]);
  for (const parameter of node.parameters) if (parameter.initializer || !ts.isIdentifier(parameter.name)) return false;
  someNode(node.body, child => { if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) locals.add(child.name.text); return false; });
  const unsafe = (child: ts.Node): boolean => {
    if (ts.isTypeNode(child)) return false;
    if (unsafeSyntax(child)) return true;
    if (ts.isCallExpression(child)) return !safeCall(child, functions, constants, next) || child.arguments.some(argument => unsafe(argument));
    if (ts.isIdentifier(child) && reference(child)) return !locals.has(child.text) && !functions.has(child.text) && !['Math', 'undefined'].includes(child.text);
    if (ts.isFunctionLike(child)) return true;
    return Boolean(ts.forEachChild(child, unsafe));
  };
  return !unsafe(node.body);
}
function bounds(file: ts.SourceFile, node: FunctionNode): { startLine: number; endLine: number } {
  return { startLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, endLine: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1 };
}
function selectFile(result: MutationSelection, file: string, ranges: [number, number][], files: Map<string, ts.SourceFile>, graph: Graph, fastTests: Map<string, string[]>): void {
  if (FIXTURE.test(file)) { result.excluded.push({ file, reason: 'fixture_or_test' }); return; }
  const parsedFile = files.get(file);
  if (!parsedFile || unsafeImports(parsedFile, files)) { result.excluded.push({ file, reason: 'unsafe_module' }); return; }
  const functions = functionsOf(parsedFile), constants = constantNames(parsedFile);
  for (const [name, node] of functions) {
    const { startLine, endLine } = bounds(parsedFile, node);
    if (!ranges.some(([start, count]) => start <= endLine && start + count > startLine)) continue;
    if (!pureFunction(name, functions, constants)) { result.excluded.push({ file, name, reason: 'purity_unproven' }); continue; }
    const tests = [...new Set(fastTests.get(file) ?? [])].filter(test => !unsafeJudge(test, files, graph)).sort();
    if (!tests.length) { result.problems.push({ file, code: 'no_safe_fast_tests' }); continue; }
    result.selected.push({ file, name, startLine, endLine, lines: Array.from({ length: endLine - startLine + 1 }, (_, index) => startLine + index), tests, reason: 'changed_pure_function' });
  }
}

/* This is a conservative static proof. Unknown calls and dependencies stay visible as exclusions rather than entering a mutator. */
export function selectMutationFunctions(input: FingerprintInput, mutation: Supported, delta: MutationDelta, graph: Graph, fastTests: Map<string, string[]>): MutationSelection {
  const result: MutationSelection = { version: 1, status: 'ready', baseCommit: delta.baseCommit, commit: delta.commit, selected: [], excluded: [], problems: [] };
  if (!validDelta(delta)) return { ...result, status: 'blocked', problems: [{ code: 'invalid_mutation_delta' }] };
  const files = parsed(input), allowed = new Set(mutation.sourcePaths), changes = new Map<string, [number, number][]>();
  for (const change of delta.changes) if (allowed.has(change.path)) changes.set(change.path, [...(changes.get(change.path) ?? []), ...change.ranges]);
  for (const file of [...changes.keys()].sort()) selectFile(result, file, changes.get(file)!, files, graph, fastTests);
  return { ...result, status: result.problems.length ? 'blocked' : 'ready' };
}
