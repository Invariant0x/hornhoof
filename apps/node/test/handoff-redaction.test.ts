import { describe, expect, it } from 'vitest';
import { classifyPath, isSanitized, REDACTED, sanitizeContent, sanitizeContext, sanitizePath, sanitizeText } from '../src/handoff-redaction.js';

/* Every secret here is made up and is built from pieces, so no scanner takes this file for a leak. */
const github = 'ghp' + '_' + 'x7Kq2Lm9Pz4Rt8Vw1Yb6Nc3Df5Gh0Jk';
const pat = 'github' + '_pat_' + '11ABCDE0Y0abcdefghij1234567890';
const openai = 'sk' + '-proj-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8';
const jwt = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const opaque = 'Zk3vQ9sT1xW7bN4mL2pR8cY6hG0dJ5fA';

function cleaned(text: string, secrets: string[] = []): string[] {
  return sanitizeText(text, secrets).text.split('\n');
}

describe('free text', () => {
  it('keeps ordinary lines exactly, in any language', () => {
    const text = 'const total = items.length;\n\n// Считает строки, Unicode is fine.\n\tindented();\nlast line without an end';
    expect(sanitizeText(text, [])).toEqual({ text, redactedRecords: 0 });
  });

  it('replaces the whole doubtful line and keeps its neighbours', () => {
    expect(cleaned(`before\nconst key = "${github}"; // noted\nafter\n`)).toEqual(['before', REDACTED, 'after', '']);
    expect(sanitizeText(`before\n${github}\nafter`, []).redactedRecords).toBe(1);
  });

  it('keeps line endings of the lines around a redaction', () => {
    expect(sanitizeText(`a\r\n${github}\r\nb\r\n`, []).text).toBe(`a\r\n${REDACTED}\r\nb\r\n`);
  });
});

describe('known secrets', () => {
  it.each([
    ['plain', 'hunter2-value'],
    ['short', 'pw1'],
    ['base64', Buffer.from('hunter2-value').toString('base64')],
    ['base64 without padding', Buffer.from('hunter2-value!').toString('base64').replace(/=+$/, '')],
    ['base64url', Buffer.from('hunter2?value>').toString('base64url')],
    ['hex', Buffer.from('hunter2-value').toString('hex')],
    ['escaped for a URL', encodeURIComponent('hunter2/value&x')],
  ])('hides the %s form', (_form, shown) => {
    const secret = _form === 'short' ? 'pw1'
      : _form === 'base64 without padding' ? 'hunter2-value!'
        : _form === 'base64url' ? 'hunter2?value>'
          : _form === 'escaped for a URL' ? 'hunter2/value&x' : 'hunter2-value';
    expect(cleaned(`keep\nconnect ${shown} now\nkeep too`, [secret])).toEqual(['keep', REDACTED, 'keep too']);
  });

  it('hides a secret that a line break splits', () => {
    const half = Math.floor(opaque.length / 2);
    expect(cleaned(`keep\nvalue ${opaque.slice(0, half)}\n${opaque.slice(half)} end\nkeep too`, [opaque]))
      .toEqual(['keep', REDACTED, REDACTED, 'keep too']);
  });

  it('hides a piece of a secret left at either end of a cut text', () => {
    expect(cleaned(`keep\nlast ${opaque.slice(0, 12)}`, [opaque])).toEqual(['keep', REDACTED]);
    expect(cleaned(`${opaque.slice(-12)} first\nkeep`, [opaque])).toEqual([REDACTED, 'keep']);
  });

  it('ignores an empty secret', () => {
    expect(sanitizeText('nothing here', ['']).redactedRecords).toBe(0);
  });
});

describe('secret shapes', () => {
  it.each([
    ['GitHub token', `token ${github}`],
    ['GitHub fine-grained token', `use ${pat}`],
    ['provider key', `key ${openai}`],
    ['Slack token', 'xoxb' + '-123456789012-abcdefGHIJKL'],
    ['AWS key id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['JWT', `session ${jwt}`],
    ['JWT cut after two parts', jwt.split('.').slice(0, 2).join('.')],
    ['Bearer', 'curl -H "x: Bearer abcdefgh12345678"'],
    ['Basic', 'Basic dXNlcjpwYXNzd29yZA=='],
    ['Authorization header', 'Authorization: whatever'],
    ['cookie header', 'Set-Cookie: sid=abc'],
    ['URL with a password', 'postgres://user:pass@db.example/app'],
    ['URL with a token as its user', 'https://abcdef123456@github.example/x.git'],
    ['HH value', 'HH_GIT_PASSWORD=abc'],
    ['environment assignment', 'export SERVICE_API_KEY=abc123'],
    ['password in a config', 'password: hunter2'],
    ['quoted secret', '"client_secret": "abc"'],
    ['token literal in code', 'const token = "abc";'],
    ['literal passed to a call', 'password = decode("abc")'],
  ])('redacts a %s', (_name, line) => {
    expect(cleaned(`keep\n${line}\nkeep too`)).toEqual(['keep', REDACTED, 'keep too']);
  });

  it.each([
    'const token = newToken();',
    'password: z.string(),',
    'token: string;',
    'secret?: string | null;',
    'const password = options.password;',
    'const apiKey = process.env.API_KEY;',
    'token: token,',
    'secrets: () => [...known],',
    'function login(password: string) {',
    'A git@github.example:org/repo.git remote stays, it has no password.',
    'see https://example.org/docs/a:b for details',
    'the risk-free path',
  ])('keeps code that holds no value: %s', line => {
    expect(sanitizeText(line, []).redactedRecords).toBe(0);
  });

  it('redacts a whole PEM block as one record', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    expect(sanitizeText(`keep\n${block}\nkeep too`, [])).toEqual({ text: `keep\n${REDACTED}\nkeep too`, redactedRecords: 1 });
  });

  it('redacts a cut PEM block up to the end of the text', () => {
    expect(cleaned('keep\n-----BEGIN PRIVATE KEY-----\nMIIEow\nabc')).toEqual(['keep', REDACTED]);
  });
});

describe('opaque values', () => {
  it.each([
    ['random letters and digits', 'value q8Zk3vQ9sT1xW7bN4mL2pR8cY6hG0dJ5fA2u'],
    ['a long hex string', 'value 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'],
    ['a base64 block', 'mF3kQ8vZ1xT9wB2nL7pR4cY6hG0dJ5fAqS8eK1uO+a/b'],
    ['base64 of a token', Buffer.from(github).toString('base64')],
  ])('redacts %s', (_name, line) => {
    expect(cleaned(`keep\n${line}\nkeep too`)).toEqual(['keep', REDACTED, 'keep too']);
  });

  it.each([
    'id 1bb1090e-7469-4997-ad22-7c963dc323e5',
    '"integrity": "sha512-q83vEMs8QJ1VQY8xZQ2Fq0ZsGv1mX3v9g3Wq0Xq0h0m1T8vDq2nLZk3vQ9sT1xW7bN4mL2pR8cY6hG0dJ5fAqA==",',
    'integrity sha512-q83vEMs8QJ1VQY8xZQ2Fq0ZsGv1mX3v9g3Wq0Xq0h0m1T8vDq2nLZk3vQ9sT1xW7bN4mL2pR8cY6hG0dJ5fAqA==',
    'createTaskWorkspaceRegistryOptionsForNodeOwnerAndAgent();',
    "import { x } from '../../packages/protocol/src/test-timings-reporter.ts';",
    'short sha 4359bcbb is fine',
    "'a'.repeat(40) + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
  ])('keeps %s', line => {
    expect(sanitizeText(line, []).redactedRecords).toBe(0);
  });
});

describe('obfuscated records', () => {
  it.each([
    ['ANSI codes', `ghp\u001b[0m_x7Kq2Lm9Pz4Rt8Vw`],
    ['a zero width character', `val​ue`],
    ['a bidirectional mark', `a‮b`],
    ['a control character', `a\u0007b`],
    ['a bare carriage return', 'progress\rlast'],
    ['full width letters', `${'ｇｈｐ＿'}x7Kq2Lm9Pz4Rt8VwYb6Nc3Df5Gh0Jk`],
    ['percent encoding', '%67%68%70%5fx7Kq2Lm9Pz4Rt8VwYb6Nc3Df5Gh0Jk'],
    ['escape codes', '\\u0067\\u0068\\u0070_x7Kq2Lm9Pz4Rt8VwYb6Nc3Df5Gh0Jk'],
    ['pieces glued in code', `"${github.slice(0, 8)}" + "${github.slice(8)}"`],
  ])('treats %s as doubtful', (_name, line) => {
    expect(cleaned(`keep\n${line}\nkeep too`)).toEqual(['keep', REDACTED, 'keep too']);
  });

  it('redacts a record too long to judge, and stays quick on it', () => {
    const started = Date.now();
    const long = 'a:b=c '.repeat(20_000);
    expect(cleaned(`keep\n${long}\nkeep too`)).toEqual(['keep', REDACTED, 'keep too']);
    const near = 'token'.repeat(3000) + ':';
    expect(sanitizeText(near.repeat(1) + 'x', []).redactedRecords).toBeLessThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a result is stable', () => {
  it('passes its own rescan, and the rescan fails on anything it would still change', () => {
    const { text } = sanitizeText(`keep\n${github}\n-----BEGIN KEY-----\nabc`, [opaque]);
    expect(isSanitized(text, [opaque])).toBe(true);
    expect(sanitizeText(text, [opaque]).text).toBe(text);
    expect(isSanitized(`keep ${github}`, [])).toBe(false);
    expect(isSanitized(`keep ${opaque}`, [opaque])).toBe(false);
  });
});

describe('file contents', () => {
  const bytes = (text: string) => Buffer.from(text);

  it('keeps a clean file byte for byte', () => {
    const source = bytes('line one\r\nline two\n');
    const out = sanitizeContent(source, []);
    expect(out).toMatchObject({ status: 'clean', redactedRecords: 0 });
    expect(out.status !== 'omitted' && out.bytes.equals(source)).toBe(true);
  });

  it('marks a file with a doubtful line as redacted, and keeps the rest', () => {
    const out = sanitizeContent(bytes(`a\n${github}\nb\n`), []);
    expect(out.status).toBe('redacted');
    expect(out.status === 'redacted' && out.bytes.toString()).toBe(`a\n${REDACTED}\nb\n`);
  });

  it.each([
    ['binary', Buffer.from([0x68, 0x00, 0x69]), 'binary'],
    ['broken encoding', Buffer.from([0x68, 0xc3, 0x28]), 'binary'],
    ['Git LFS pointer', bytes('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n'), 'lfs'],
    ['oversized', Buffer.alloc(1024 * 1024 + 1, 0x61), 'too_large'],
  ])('withholds a %s file', (_name, content, reason) => {
    expect(sanitizeContent(content, [])).toEqual({ status: 'omitted', reason });
  });
});

describe('paths', () => {
  it.each([
    ['src/app.ts', 'task'],
    ['docs/build.md', 'task'],
    ['.env', 'sensitive'],
    ['config/.env.production', 'sensitive'],
    ['.git/config', 'sensitive'],
    ['a/.git/hooks/pre-push', 'sensitive'],
    ['.npmrc', 'sensitive'],
    ['deploy/id_rsa', 'sensitive'],
    ['certs/server.pem', 'sensitive'],
    ['home/.ssh/known_hosts', 'sensitive'],
    ['.claude/settings.json', 'sensitive'],
    ['.codex/auth.json', 'sensitive'],
    ['credentials.json', 'sensitive'],
    ['config/secrets.yaml', 'sensitive'],
    ['node_modules/a/index.js', 'artifact'],
    ['apps/web/dist/main.js', 'artifact'],
    ['coverage/lcov.info', 'artifact'],
    ['pkg/__pycache__/a.pyc', 'artifact'],
    ['.turbo/log', 'artifact'],
  ])('classes %s as %s', (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it('keeps a clean path, and hides one that a secret or a control character is in', () => {
    expect(sanitizePath('src/cases/a b.ts', [])).toEqual({ path: 'src/cases/a b.ts', clean: true });
    expect(sanitizePath(`src/${github}.txt`, [])).toEqual({ path: REDACTED, clean: false });
    expect(sanitizePath(`src/${opaque}.txt`, [opaque])).toEqual({ path: REDACTED, clean: false });
    expect(sanitizePath('src/a\nb.txt', [])).toEqual({ path: REDACTED, clean: false });
  });
});

describe('context files', () => {
  it('cuts at a whole record, from the end, and says so', () => {
    const records = Array.from({ length: 50 }, (_, i) => `record ${String(i).padStart(3, '0')}`).join('\n');
    const out = sanitizeContext(records, [], 120);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
    expect(out.startsWith('[cut: older records left out]\n')).toBe(true);
    expect(out.endsWith('record 049')).toBe(true);
    expect(out.split('\n').slice(1).every(line => /^record \d{3}$/.test(line))).toBe(true);
  });

  it('cleans before it cuts, and a record too long for the limit goes as redacted', () => {
    expect(sanitizeContext(`keep\n${github}\nend`, [], 1000)).toBe(`keep\n${REDACTED}\nend`);
    expect(sanitizeContext(`${'x '.repeat(500)}`, [], 40)).toBe(REDACTED);
  });

  it('says plainly when there is nothing', () => {
    expect(sanitizeContext(null, [], 100)).toBe('unavailable\n');
  });
});
