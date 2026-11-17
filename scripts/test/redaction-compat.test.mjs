import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const { CREDENTIALS, cleanDiagnostic, HIDDEN, hiddenBy, PRIVATE_PATHS, PROSE_CREDENTIALS } = await tsImport('../../packages/protocol/src/redaction.ts', import.meta.url);
const mixed = JSON.parse(readFileSync(new URL('../../packages/protocol/test/fixtures/redaction-mixed.json', import.meta.url), 'utf8'));
const oldUrl = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const oldReplacement = `$1${HIDDEN}@`;
const [currentUrl, replacement] = PROSE_CREDENTIALS.find(([pattern]) => !(pattern instanceof RegExp));
const oldUrlMask = text => text.replace(oldUrl, oldReplacement);
const currentUrlMask = text => text.replace(currentUrl, replacement);

test('the URL scanner preserves the original output for the 64,420 scheme-prefix cases', () => {
  const letters = ['a', 'Z', '0', '+', '-', '.', '_', '/', ':', '@', '\n'];
  const suffixes = ['https://bruno:pa55word@host.example/path', 'git+ssh://name:pass@host', 'plain-text', 'https://no-password@host'];
  let prefixes = [''], checked = 0;
  for (let length = 0; length <= 4; length++) {
    for (const prefix of prefixes) for (const suffix of suffixes) {
      const text = prefix + suffix;
      assert.equal(currentUrlMask(text), oldUrlMask(text), text);
      checked++;
    }
    if (length < 4) prefixes = prefixes.flatMap(prefix => letters.map(letter => prefix + letter));
  }
  assert.equal(checked, 64_420);
});

test('the two failing inputs and three mixed credential inputs keep the old URL behavior and secret masks', () => {
  const token = 'sk-ant-oat01-abcdefghijklmnop';
  const plain = [
    `key=${token} again ${token} encoded ${Buffer.from(token).toString('base64')}`,
    JSON.stringify({ tool_name: 'Bash', tool_use_id: 'call-private-secret-123', tool_input: { command: 'read ./tmp/mine private-secret-123' } }),
  ];
  /* Neither original failure is a URL: the node's explicit secret list, not the URL expression, masks these values. */
  for (const text of plain) {
    assert.equal(oldUrlMask(text), text);
    assert.equal(currentUrlMask(text), text);
  }
  const oldCredentials = CREDENTIALS.map(([pattern, value]) => pattern instanceof RegExp ? [pattern, value] : [oldUrl, oldReplacement]);
  for (const { text, diagnosticExpected, knownSecrets } of mixed) {
    assert.equal(currentUrlMask(text), oldUrlMask(text));
    const oldDiagnostic = hiddenBy(hiddenBy(text, oldCredentials), PRIVATE_PATHS);
    assert.equal(oldDiagnostic, diagnosticExpected);
    assert.equal(cleanDiagnostic(text), diagnosticExpected);
    for (const secret of knownSecrets) assert.ok(!oldDiagnostic.includes(secret));
  }
  assert.equal(plain.length + mixed.length, 5);
});
