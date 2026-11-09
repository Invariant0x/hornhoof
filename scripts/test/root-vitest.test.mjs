import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
