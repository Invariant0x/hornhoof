import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyServerOptions, type RouteOptions } from 'fastify';
import ts from 'typescript';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { testApp } from './helpers.js';

const captured = vi.hoisted(() => [] as RouteOptions[]);
vi.mock('fastify', async importOriginal => {
  const actual = await importOriginal<typeof import('fastify')>();
  return { ...actual, default: (options: FastifyServerOptions = {}) => {
    const app = actual.default(options);
    app.addHook('onRoute', route => { captured.push({ ...route }); });
    return app;
  } };
});

/* Existing routes declare their policy by calling a guard. Public endpoints are an exact
   method/path registry, so a new endpoint cannot inherit an exemption from a prefix. */
const publicRoutes = new Map([
  ['GET /*', 'public web assets'],
  ['GET /api/health', 'public health'],
  ['GET /api/version', 'public version'],
  ['GET /api/setup', 'public setup availability'],
  ['GET /install.sh', 'public installer'],
  ['GET /robots.txt', 'public word to crawlers'],
  ['GET /.well-known/acme-challenge/*', 'public answer to the certificate authority'],
  ['GET /install.ps1', 'public installer for Windows'],
  ['GET /mcp', 'public method rejection'],
  ['DELETE /mcp', 'public method rejection'],
  ['GET /api/assistant/mcp', 'public method rejection'],
  ['DELETE /api/assistant/mcp', 'public method rejection'],
  ['POST /api/feedback/inbound', "public feedback receiver, only on Hornhoof's own installation: a report of the strict shape, at most 16 KB with a shared ingress budget, which adds a signal to the inbox and does nothing else"],
]);
const guards: { name: string; path: RegExp; rule: string }[] = [
  { name: 'requirePerson', path: /^\/api\//, rule: 'human session and company scope' },
  { name: 'agentFor', path: /^\/api\/agents\//, rule: 'human session and reachable agent' },
  { name: 'programFor', path: /^\/api\/agents\/:id\/terminal$/, rule: 'human session and the plan the program really runs on' },
  { name: 'jobOf', path: /^(?:\/mcp|\/api\/attachments(?:\/file)?)$/, rule: 'agent job token' },
  { name: 'attachmentJobOf', path: /^\/api\/attachments$/, rule: 'agent job token or signed upload permission for the live turn and its company task' },
  { name: 'fileByLink', path: /^\/api\/files\/\*$/, rule: 'signed link to one file, for 7 days after it was made, which downloads that file and does nothing else' },
  { name: 'setupOnly', path: /^\/api\/setup(?:\/names\/:name)?$/, rule: 'first setup code' },
  { name: 'withCode', path: /^\/api\/recovery(?:\/restore)?$/, rule: 'first setup code, on a server with no company yet' },
  { name: 'recovering', path: /^\/api\/recovery\/challenge$/, rule: 'on a server with no company that was given a recovery file: answers only a challenge that file opens, and nothing else' },
  { name: 'proven', path: /^\/api\/recovery\/bundles\/:id$/, rule: 'the proof of a challenge this server answered, made for that bundle, or the first setup code' },
  { name: 'openInvite', path: /^\/api\/invites\/:token(?:\/accept)?$/, rule: 'valid invitation token' },
  { name: 'ownPlan', path: /^\/api\/subscriptions\/:id\/(?:signin(?:\/(?:stop|terminal))?|connecting\/(?:cancel|retry))$/, rule: 'human subscription owner, or the orchestrator' },
  { name: 'ownScreen', path: /^\/api\/nodes\/commands(?:\/:id\/hide)?$/, rule: 'human owner of install commands, or the orchestrator acting for them' },
  { name: 'requireCompanyPerson', path: /^\/api\/(?:updates|link|feedback\/inbox|feedback\/repeats)(?:\/.*)?$/, rule: 'human company scope' },
  { name: 'person', path: /^\/api\/improvements(?:\/:id\/(?:take|dismiss))?$/, rule: 'human company scope' },
  { name: 'bookFor', path: /^\/api\/(?:departments\/:id\/)?notebook(?:\/:number)?$/, rule: 'human reachable notebook' },
  { name: 'viewer', path: /^\/api\/computer$/, rule: 'human company scope' },
  { name: 'ceo', path: /^\/api\/computer\/(?:open|close|decline)$/, rule: 'human CEO or delegate, or the orchestrator' },
  { name: 'targets', path: /^\/api\/nodes\/update$/, rule: 'node key and builtin scope for server updates' },
  { name: 'identify', path: /^\/api\/nodes\/socket$/, rule: 'node key before websocket upgrade' },
  { name: 'nodeOf', path: /^\/api\/harness\/(?:claim|:key\/(?:done|failed|bundle|parts\/:index))$/, rule: 'node key, and a build of that node or of a product whose tests it may take' },
  { name: 'requireKeeper', path: /^\/api\/network\/(?:certificate|peers|report|secrets|backups|computer(?:\/:id)?)$/, rule: "this machine's keeper alone: its address together with the header no door lets through" },
  { name: 'redeemTicket', path: /^\/api\/network\/join$/, rule: "the one-use join ticket and a signature from the machine's key" },
  { name: 'signedRenewal', path: /^\/api\/network\/renew$/, rule: "a request signed with the machine's own key, of this moment and taken once" },
  { name: 'ownSession', path: /^\/api\/me\/key$/, rule: "the person's own session, or the orchestrator acting for them, never a head" },
  { name: 'partOf', path: /^\/api\/parts\/:id\/files\/:name$/, rule: 'node key and active owned work part' },
  { name: 'requireAssistant', path: /^\/api\/assistant\//, rule: "assistant key, acting with its owner's rights as they are now" },
];

function callName(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node)) return callName(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return callName(node.right);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isIdentifier(node) ? node.text : undefined;
}

/* Read executable calls, not comments or strings. A guard hidden in an unused callback
   or a conditional branch is not an unconditional access declaration. */
function directCalls(handler: unknown): Set<string> {
  const source = ts.createSourceFile('handler.ts', `(${String(handler)})`, ts.ScriptTarget.Latest, true);
  const calls = new Set<string>();
  function visit(node: ts.Node, root = false): void {
    if (!root && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) )) return;
    if (ts.isIfStatement(node)) return visit(node.expression);
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name) calls.add(name);
    }
    node.forEachChild(child => visit(child));
  }
  const statement = source.statements[0];
  if (statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)) visit(statement.expression.expression, true);
  return calls;
}

function ruleForMethod(route: RouteOptions, registered: string): string | undefined {
  const method = registered === 'HEAD' ? 'GET' : registered;
  const publicRule = publicRoutes.get(`${method} ${route.url}`);
  if (publicRule) return publicRule;
  const calls = new Set([route.handler, ...[route.preValidation ?? []].flat()].flatMap(handler => [...directCalls(handler)]));
  const declared = guards.find(guard => guard.path.test(route.url) && calls.has(guard.name));
  if (declared) return declared.rule;
  if (method === 'POST' && route.url === '/api/auth/login' && calls.has('verifyPassword') && calls.has('startSession')) return 'verified credentials';
  if (method === 'POST' && route.url === '/api/auth/logout' && calls.has('endSession')) return 'end only the supplied session';
  if (method === 'POST' && route.url === '/api/nodes/join' && calls.has('hashToken') && String(route.handler).includes('code_unknown')) return 'valid install code';
  return undefined;
}

function accessRule(route: RouteOptions): string | undefined {
  const rules = [route.method].flat().map(method => ruleForMethod(route, method));
  return rules.every(rule => rule !== undefined) ? rules.join('; ') : undefined;
}

function assertDeclared(routes: RouteOptions[]): void {
  const missing = routes.filter(route => !accessRule(route)).map(route => `${route.method} ${route.url}`);
  if (missing.length) throw new Error(`Routes without an access declaration:\n${missing.join('\n')}`);
}

const requirePerson = () => undefined;

describe('route access declarations', () => {
  it('requires an explicit access rule for every registered HTTP and WS route, including static assets', async () => {
    captured.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'hh-route-access-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Test</title>');
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const { app } = await testApp({ WEB_DIST: dir });
    await app.ready();
    expect(captured.some(route => route.url === '/api/nodes/socket')).toBe(true);
    expect(captured.some(route => route.url === '/api/agents/:id/terminal')).toBe(true);
    expect(captured.some(route => route.url.includes('*'))).toBe(true);
    assertDeclared(captured);
  });

  it('rejects a real newly registered route without a declaration', async () => {
    captured.length = 0;
    const { app } = await testApp();
    app.get('/api/undeclared', async () => ({ ok: true }));
    await app.ready();
    expect(() => assertDeclared(captured)).toThrow('GET /api/undeclared');
  });

  it('does not mistake comments, strings, callbacks or conditional guards for an access declaration', () => {
    const route = (handler: RouteOptions['handler']): RouteOptions => ({ method: 'GET', url: '/api/undeclared', handler });
    expect(accessRule(route(async () => 'requirePerson(req, db)'))).toBeUndefined();
    expect(directCalls(async () => { const later = () => requirePerson(); return later; })).not.toContain('requirePerson');
    expect(directCalls(async () => { if (false) requirePerson(); })).not.toContain('requirePerson');
    expect(accessRule({ method: 'POST', url: '/api/health', handler: async () => ({}) })).toBeUndefined();
  });
});

it('audits every method of a real method-array registration', async () => {
  captured.length = 0;
  const app = Fastify();
  onTestFinished(() => app.close());
  app.route({ method: ['GET', 'POST'], url: '/api/health', handler: async () => ({ ok: true }) });
  await app.ready();
  expect(() => assertDeclared(captured)).toThrow('/api/health');
});
