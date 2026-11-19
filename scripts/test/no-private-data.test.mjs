import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { trackedIn } from './tracked-files.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/* The repository is public: its texts name no real person but its author, no real company and no real mailbox. Examples and
   fixtures use the made-up company of the media scenes (Moonfern). The words that must not come back are kept here only as
   SHA-256 of the lowercased word, so this list does not publish them again; a mailbox is kept as its name up to the @. */
const DENIED = new Map([
  ['deed29a14606957869aefe56cf28e10c2ee3317aad68238fe1a753401c9e0060', 'a real company'],
  ['73e4935fcd6dfbc26aa88d49b1304bff6f1dfdcfaa021e72e73d06025286eb1c', 'a real person'],
  ['1150b7957dfeecc8b6ddf32de3ba39a9b018c4737dd2e77157902d009cdf19b3', 'a real person'],
  ['95c08c72c3f4c5ede972450f3b3719587cb7891884c0b7b57c8aa2bd22b6b200', 'a real person'],
  ['cd16575ec9a0d53db710a8f4a8bcfef3da336ee7fe948a7cd356a9158f89dc7d', 'a real person'],
  ['ead20c3b4d956d75464363d5c8611799a826255dca3c8da34478b754e802d4c9', 'a real person'],
  ['a568c3442ab3983fa0c016e053b07e7c36e5ba72dc9d09ad9e8a68581344694a', 'a real person'],
  ['d1b9aaa1211cd9ded2f1860f2aeadf1f85cd2e9516a0936e2b31d966144f15fd', 'a real person'],
  ['1dc7594e8874fb1c4f8c9742eae1397687bb358f505b01cc7defec09ac2a86fb', 'a real person'],
  ['dad01e911d1c3fe58c75f65e4889dab1dada8e3afe1099f7b57326b9a53e9b9a', 'a real person'],
  ['074b1dc589cc22c898f372c4e0590863174f9734ee816a0da5f8edb30b4612e6', 'a real person'],
  ['95a1884e236aff4611bf8df4697a409faae67872e3e4d58fa4ef4b4fece1d8de', 'a real person'],
  ['eb7fe437e078eaafe099949fee0bf5eb4f3f0eb877426bd7dd5169a8d59cd1c3', 'a real person'],
  ['b53f83f53530b10b607cde7659e5daf1d41557c4aaf0a7ea879711b10fa538db', 'a real person'],
  ['ad022d93e04a8c5491b2e2449214b0f70ecda696221db7a0767ff9e1f4436e4e', 'a real person'],
  ['a0fe90d6138dbfb69038c9bf00bdf056f278aec75dbb94bf6706cd3a877884c2', 'a real person'],
  ['0f7f302cee26a5e22ae4ce984fe9d6f03d135004ab60e242ded0fe7ecab5f29a', 'a real person'],
  ['c2db02f920598017f39e4fee28b83e10d14ec40791e6e7130462b6d0d4617d8b', 'a real person'],
  ['86fb3e155d1989d60ee1d218540bfad61b5ba26f0d0fed698a9060ef115ba228', 'a real person'],
  ['9da9051443e6e9a408fafea28a56da614798eaa05bdc9c453b1b3766a81832e6', 'a real person'],
  ['0f440e9bb5219a4fbf46b62e64b2ee703d5165a8803047b4d32269065f9ed059', 'a real mailbox'],
]);

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/* An address ends where its domain does, never at the full stop of the sentence after it. */
const ADDRESS = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)?/gu;
const sha256 = text => createHash('sha256').update(text).digest('hex');

/* Every word of a text in any script, and every address both whole and up to its @, lowercased. */
function tokensOf(text) {
  const lower = text.toLowerCase();
  const tokens = new Set(lower.match(WORD));
  for (const address of lower.match(ADDRESS) ?? []) {
    tokens.add(address);
    tokens.add(address.slice(0, address.indexOf('@') + 1));
  }
  return tokens;
}

/* What a text holds of a denied list: the label of each denied token, each once, never the token itself. */
function deniedIn(text, denied) {
  return [...new Set([...tokensOf(text)].map(token => denied.get(sha256(token))).filter(Boolean))].sort();
}

/* The regular files of the index that hold text: links and submodules are not read, and a file with a NUL byte is binary. */
function trackedTexts() {
  return trackedIn(root).filter(file => file.mode === '100644' || file.mode === '100755').flatMap(({ path }) => {
    const bytes = readFileSync(join(root, path));
    return bytes.includes(0) ? [] : [{ path, text: bytes.toString('utf8') }];
  });
}

test('reads words in any script and addresses whole and up to their @, whatever their case', () => {
  assert.deepEqual([...tokensOf('Leo of Moonfern asks Сэм: write to Maya@Moonfern.app or news@.')].sort(), [
    'app', 'asks', 'leo', 'maya', 'maya@', 'maya@moonfern.app', 'moonfern', 'news', 'news@', 'of', 'or', 'to', 'write', 'сэм',
  ]);
  assert.deepEqual([...tokensOf('Mail leo@moonfern.app.')].filter(token => token.includes('@')).sort(), ['leo@', 'leo@moonfern.app']);
});

test('finds a denied word or mailbox by its hash alone', () => {
  const denied = new Map([[sha256('moonfern'), 'a company'], [sha256('сэм'), 'a person'], [sha256('maya@'), 'a mailbox']]);
  assert.deepEqual(deniedIn('Moonfern ships the beta.', denied), ['a company']);
  assert.deepEqual(deniedIn('СЭМ and Сэм look at it.', denied), ['a person']);
  assert.deepEqual(deniedIn('Mail maya@other.example today.', denied), ['a mailbox']);
  assert.deepEqual(deniedIn('Moonfernish, mayan and maya.', denied), []);
});

test('no tracked text names a real person, company or mailbox that must not come back', () => {
  const found = trackedTexts().flatMap(({ path, text }) => deniedIn(text, DENIED).map(label => `${path}: ${label}`));
  assert.deepEqual(found, []);
});
