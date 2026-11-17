import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import config from '../mutation/vitest.config.mjs';

test('mutation tests resolve protocol imports to the pinned source rather than build output', () => {
  for (const [specifier, file] of [['@hornhoof/protocol', 'index.ts'], ['@hornhoof/protocol/redaction', 'redaction.ts'], ['@hornhoof/protocol/program-operator', 'program-operator.ts']]) {
    const alias = config.test.alias?.find(({ find }) => find.test(specifier));
    assert.ok(alias, `No source alias for ${specifier}`);
    const resolved = specifier.replace(alias.find, alias.replacement);
    assert.equal(resolved, fileURLToPath(new URL(`../../packages/protocol/src/${file}`, import.meta.url)));
  }
});
