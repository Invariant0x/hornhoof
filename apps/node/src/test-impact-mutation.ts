import { posix } from 'node:path';
import ts from 'typescript';
import { RepositoryPath, type TestEnvironmentV1, type MutationDelta, type MutationSelection } from '@hornhoof/protocol';
import type { FingerprintInput } from './test-fingerprint.js';

export type { MutationDelta, MutationFunction, MutationSelection } from '@hornhoof/protocol';
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
  if (!clause) return false;
  return clause.isTypeOnly || (!clause.name && onlyNamedTypes(clause.namedBindings));
}
function onlyNamedTypes(bindings: ts.NamedImportBindings | undefined): boolean {
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly));
}
function resolves(files: Map<string, ts.SourceFile>, from: string, specifier: string): boolean {
  const target = posix.join(posix.dirname(from), specifier), stem = target.replace(/\.[cm]?js$/, '');
  return [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '/index.ts', '/index.js'].map(extension => stem + extension)].some(path => files.has(path));
}
function runtimeImport(node: ts.Statement): string | null | undefined {
  if (ts.isImportEqualsDeclaration(node)) return undefined;
  if (ts.isImportDeclaration(node) && importedTypes(node)) return null;
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return null;
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return null;
  return importText(node.moduleSpecifier);
}
function importText(specifier: ts.Expression | undefined): string | null | undefined {
  if (!specifier) return null;
  return ts.isStringLiteral(specifier) ? specifier.text : undefined;
}
function unsafeImports(file: ts.SourceFile, files: Map<string, ts.SourceFile>): boolean {
  return file.statements.some(node => {
    const specifier = runtimeImport(node);
    if (specifier === undefined) return true;
    if (specifier === null) return false;
    return specifier.startsWith('.') ? !resolves(files, file.fileName, specifier) : !(specifier === 'vitest' && FIXTURE.test(file.fileName));
  });
}
function someNode(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  return predicate(node) || Boolean(ts.forEachChild(node, child => someNode(child, predicate)));
}
const DECLARATIONS = new Set([ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ExportDeclaration, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.InterfaceDeclaration]);
function unsafeInitializer(item: ts.VariableDeclaration): boolean {
  if (/\bMath\b/.test(item.name.getText())) return true;
  const value = item.initializer;
  if (!value || ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return false;
  return someNode(value, child => ts.isCallExpression(child) || unsafeSyntax(child) || (ts.isIdentifier(child) && FORBIDDEN.has(child.text)));
}
function unsafeInitialization(file: ts.SourceFile): boolean {
  return file.statements.some(node => ts.isVariableStatement(node) ? node.declarationList.declarations.some(unsafeInitializer) : !DECLARATIONS.has(node.kind));
}
function unsafeJudge(path: string, files: Map<string, ts.SourceFile>, graph: Graph): boolean {
  return [...graph.closure(path)].some(file => {
    const node = files.get(file);
    return !node || /(?:^|\/)(?:fixtures?|__fixtures__)(?:\/|$)/.test(file) || unsafeImports(node, files)
      || someNode(node, unsafeJudgeCode);
  });
}
function unsafeJudgeCode(node: ts.Node): boolean {
  return (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);
}
function assignedFunction(item: ts.VariableDeclaration): [string, FunctionNode][] {
  const value = item.initializer;
  return ts.isIdentifier(item.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? [[item.name.text, value]] : [];
}
function functionsOf(file: ts.SourceFile): Functions {
  const functions: Functions = new Map();
  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations.flatMap(assignedFunction)) functions.set(...item);
  }
  return functions;
}
function constantNames(file: ts.SourceFile): Set<string> {
  return new Set(file.statements.filter(ts.isVariableStatement).filter(statement => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap(statement => statement.declarationList.declarations.filter(item => ts.isIdentifier(item.name) && item.initializer && (ts.isLiteralExpression(item.initializer) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(item.initializer.kind))).map(item => item.name.getText(file))));
}
function reference(node: ts.Identifier): boolean {
  const parent = node.parent;
  const named = ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent);
  return !named || parent.name !== node;
}
function safeCall(node: ts.CallExpression, names: Functions, constants: Set<string>, seen: Set<string>, locals: Set<string>): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return names.has(callee.text) && pureFunction(callee.text, names, constants, seen);
  return !names.has('Math') && !locals.has('Math') && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Math' && MATH.has(callee.name.text);
}
const EFFECTS = new Set([ts.SyntaxKind.NewExpression, ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.YieldExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.TaggedTemplateExpression]);
function unsafeSyntax(node: ts.Node): boolean {
  if (EFFECTS.has(node.kind)) return true;
  if (ts.isBinaryExpression(node)) return node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
}
function localNames(node: FunctionNode, body: ts.ConciseBody, constants: Set<string>): Set<string> {
  const locals = new Set([...constants, ...node.parameters.map(parameter => parameter.name.getText())]);
  someNode(body, child => { if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) locals.add(child.name.text); return false; });
  return locals;
}
interface BodyContext { functions: Functions; constants: Set<string>; seen: Set<string>; locals: Set<string> }
function unknownReference(node: ts.Identifier, context: BodyContext): boolean {
  return reference(node) && !context.locals.has(node.text) && !context.functions.has(node.text) && !['Math', 'undefined'].includes(node.text);
}
function unsafeBody(child: ts.Node, context: BodyContext): boolean {
  if (ts.isTypeNode(child)) return false;
  if (unsafeSyntax(child)) return true;
  if (ts.isCallExpression(child)) return !safeCall(child, context.functions, context.constants, context.seen, context.locals) || child.arguments.some(argument => unsafeBody(argument, context));
  if (ts.isIdentifier(child)) return unknownReference(child, context);
  if (ts.isFunctionLike(child)) return true;
  return Boolean(ts.forEachChild(child, next => unsafeBody(next, context)));
}
function asynchronous(node: FunctionNode): boolean {
  return Boolean(('asteriskToken' in node && node.asteriskToken) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}
function pureFunction(name: string, functions: Functions, constants: Set<string>, seen: Set<string> = new Set()): boolean {
  const node = functions.get(name)!;
  if (seen.has(name) || !node.body || asynchronous(node)) return false;
  if (node.parameters.some(parameter => parameter.initializer || !ts.isIdentifier(parameter.name))) return false;
  return !unsafeBody(node.body, { functions, constants, seen: new Set([...seen, name]), locals: localNames(node, node.body, constants) });
}
function bounds(file: ts.SourceFile, node: FunctionNode): { startLine: number; endLine: number } {
  return { startLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, endLine: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1 };
}
function sharesLine(file: ts.SourceFile, node: FunctionNode, functions: Functions): boolean {
  const { startLine, endLine } = bounds(file, node);
  return [...functions.values()].some(other => other !== node && bounds(file, other).startLine <= endLine && bounds(file, other).endLine >= startLine);
}
function functionExclusion(file: ts.SourceFile, name: string, node: FunctionNode, functions: Functions, constants: Set<string>): string | null {
  if (sharesLine(file, node, functions)) return 'shared_function_line';
  return pureFunction(name, functions, constants) ? null : 'purity_unproven';
}
function sourceOf(file: string, files: Map<string, ts.SourceFile>): { source: ts.SourceFile } | { reason: string } {
  if (FIXTURE.test(file)) return { reason: 'fixture_or_test' };
  const source = files.get(file);
  return !source || unsafeImports(source, files) || unsafeInitialization(source) ? { reason: 'unsafe_module' } : { source };
}
function selectFile(result: MutationSelection, file: string, ranges: [number, number][], files: Map<string, ts.SourceFile>, graph: Graph, fastTests: Map<string, string[]>): void {
  const found = sourceOf(file, files);
  if ('reason' in found) { result.excluded.push({ file, reason: found.reason }); return; }
  selectFunctions(result, found.source, ranges, files, graph, fastTests);
}
function selectFunctions(result: MutationSelection, parsedFile: ts.SourceFile, ranges: [number, number][], files: Map<string, ts.SourceFile>, graph: Graph, fastTests: Map<string, string[]>): void {
  const file = parsedFile.fileName;
  const functions = functionsOf(parsedFile), constants = constantNames(parsedFile);
  for (const [name, node] of functions) {
    const { startLine, endLine } = bounds(parsedFile, node);
    if (!ranges.some(([start, count]) => start <= endLine && start + count > startLine)) continue;
    const reason = functionExclusion(parsedFile, name, node, functions, constants);
    if (reason) { result.excluded.push({ file, name, reason }); continue; }
    const tests = [...new Set(fastTests.get(file) ?? [])].filter(test => !unsafeJudge(test, files, graph)).sort();
    if (!tests.length) { result.problems.push({ file, code: 'no_safe_fast_tests' }); continue; }
    result.selected.push({ file, name, startLine, endLine, lines: Array.from({ length: endLine - startLine + 1 }, (_, index) => startLine + index), tests, reason: 'changed_pure_function' });
  }
}

/* This is a conservative static proof. Unknown calls and dependencies stay visible as exclusions rather than entering a mutator. */
export function selectMutationFunctions(input: FingerprintInput, mutation: Supported, delta: MutationDelta, graph: Graph, fastTests: Map<string, string[]>): MutationSelection {
  const result: MutationSelection = { version: 1, status: 'ready', baseCommit: delta.baseCommit, commit: delta.commit, selected: [], excluded: [], problems: [] };
  if (!validDelta(delta)) return { ...result, status: 'blocked', problems: [{ code: 'invalid_mutation_delta' }] };
  if (!['typescript', 'javascript'].includes(mutation.language)) return { ...result, status: 'blocked', problems: [{ code: 'unsupported_mutation_language' }] };
  const files = parsed(input), allowed = new Set(mutation.sourcePaths), changes = new Map<string, [number, number][]>();
  for (const change of delta.changes) if (allowed.has(change.path)) changes.set(change.path, [...(changes.get(change.path) ?? []), ...change.ranges]);
  for (const file of [...changes.keys()].sort()) selectFile(result, file, changes.get(file)!, files, graph, fastTests);
  return { ...result, status: result.problems.length ? 'blocked' : 'ready' };
}
