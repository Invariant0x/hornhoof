import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import config from '../../vitest.config.mjs';

const required = ['@hornhoof/node', '@hornhoof/node:no-proc', '@hornhoof/protocol', '@hornhoof/server', '@hornhoof/web'];
const cwdSetup = fileURLToPath(new URL('./workspace-cwd.mjs', import.meta.url));

/* The root config as written, without Vitest: which files Vitest then collects and selects is Vitest's to say. */
test('root projects name every workspace config and the existing no-proc variant', () => {
  const { projects } = config.test;
  assert.deepEqual(projects.map(project => project.test.name).sort(), required);
  for (const project of projects) {
    assert.ok(existsSync(project.extends), project.extends);
    assert.deepEqual([project.test.provide.workspaceRoot, project.test.setupFiles], [project.root, [cwdSetup]], project.test.name);
  }
});

const scriptsOf = folder => JSON.parse(readFileSync(new URL(`../../${folder}package.json`, import.meta.url), 'utf8')).scripts ?? {};
const packages = ['packages/protocol/', 'apps/node/', 'apps/server/', 'apps/web/'].map(scriptsOf);
/* What npm runs for a script, step by step: a script of the same package it names in its place, and each package's pretest
   before its test where the script runs the test of every package. */
function steps(script, scripts) {
  return script.split('&&').map(step => step.trim()).flatMap(step => {
    const named = /^npm run (?:-s )?([\w:-]+)$/.exec(step);
    if (named && scripts[named[1]]) return steps(scripts[named[1]], scripts);
    if (/^npm test --workspaces\b/.test(step)) return packages.flatMap(own => [...(own.pretest ? steps(own.pretest, own) : []), ...(own.test ? [own.test] : [])]);
    return [step];
  });
}
const PROTOCOL = /^npm run (?:-s )?build -w @hornhoof\/protocol$/, NODE = /^npm run (?:-s )?build -w @hornhoof\/node$/;

/* Every step builds through the machine's check queue, where a build of the protocol waited minutes for one of under a second. */
test('npm test at the root builds the protocol once and the node before the tests of every project run in one Vitest', () => {
  const root = steps(scriptsOf('').test, scriptsOf(''));
  assert.equal(root.filter(step => PROTOCOL.test(step)).length, 1, root.join(' && '));
  assert.equal(root.at(-1), 'vitest run');
  assert.ok(root.findIndex(step => NODE.test(step)) >= 0 && root.findIndex(step => NODE.test(step)) < root.length - 1, root.join(' && '));
});

test('the tests of the server and of the node, run in their own folder, still build what they read first', () => {
  const [, node, server] = packages;
  assert.ok(steps(server.pretest, server).some(step => PROTOCOL.test(step)));
  assert.deepEqual(steps(node.pretest, node).map(step => PROTOCOL.test(step) ? 'protocol' : step), ['protocol', 'tsc -p tsconfig.json']);
});
