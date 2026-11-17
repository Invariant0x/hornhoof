import { describe, expect, it, vi } from 'vitest';
import { CREDENTIALS, cleanDiagnostic, HIDDEN, hideCredentials, hiddenBy, MIN_SECRET_LENGTH, PRIVATE_PATHS } from '../src/redaction.js';

describe('stored prose, masked as it is written', () => {
  it('hides labelled passwords and credentials of a known format', () => {
    const cases: [string, string][] = [
      ['пароль: taskBody987! и Password qwerty123!', `пароль: ${HIDDEN} и Password ${HIDDEN}`],
      ['password = "two words" then', `password = ${HIDDEN} then`],
      ['token ghp_abcDEF0123456789abcdef0123 refused', `token ${HIDDEN} refused`],
      ['https://bruno:pa55word@github.com/acme/app.git', `https://${HIDDEN}@github.com/acme/app.git`],
      ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- done', `${HIDDEN} done`],
    ];
    for (const [text, clean] of cases) expect(hideCredentials(text), text).toBe(clean);
  });

  it('keeps code, headers, flags, links and ordinary words as they are written', () => {
    for (const plain of [
      'const token = getToken(req);',
      'Pass { key: c.ids.dana } to the helper.',
      'secret: z.string().min(1),',
      'Authorization: Bearer header is checked in auth/session.ts',
      'Review checks correctness, simplicity and basic security.',
      'Run hh-node --join CODE on the machine',
      'OAuth returns to /callback?code=XYZ&state=1',
      'Reset the password 2 times before release',
      'In the password #267 task, hide it',
      'The primary key: id, unique per company',
      'Сменить пароль завтра, задача #267',
    ]) expect(hideCredentials(plain), plain).toBe(plain);
  });

  it('hides an exact value only from eight characters on', () => {
    expect(MIN_SECRET_LENGTH).toBe(8);
  });

  it('keeps a maximum-size assistant conversation and masks a following URL password', () => {
    const conversation = 'f'.repeat(200_000);
    const text = `${conversation}\nhttps://bruno:pa55word@github.com/acme/app.git`;
    const expected = `${conversation}\nhttps://${HIDDEN}@github.com/acme/app.git`;
    expect(hideCredentials(text)).toBe(expected);
    expect(cleanDiagnostic(text)).toBe(expected);
  });

  it('masks URL passwords beside scheme characters, with their prefixes and public addresses preserved', () => {
    for (const prefix of ['', '0', '+.-', '10+.-', '_', '/', '(', 'text:']) {
      const address = `${prefix}git+ssh://bruno:pa55word@host.example/repo`;
      const expected = `${prefix}git+ssh://${HIDDEN}@host.example/repo`;
      expect(hideCredentials(address), address).toBe(expected);
      expect(cleanDiagnostic(address), address).toBe(expected);
    }
  });

  it('leaves incomplete URL credentials alone and still hides later nested or separate URLs', () => {
    for (const plain of [
      '://user:pass@host', '123://user:pass@host', 'a://:pass@host', 'a://user:@host',
      'a://user:pass/part@host', 'a://user name:pass@host', 'a://user:pass word@host',
    ]) expect(hideCredentials(plain), plain).toBe(plain);
    expect(hideCredentials('a://a://user:pass@host')).toBe(`a://a://${HIDDEN}@host`);
    expect(hideCredentials('a://user:one:two@host b://other:pass@next')).toBe(`a://${HIDDEN}@host b://${HIDDEN}@next`);
  });

  it('uses bounded URL searches on long words at two input sizes', () => {
    const find = String.prototype.indexOf;
    const read = String.prototype.charAt;
    const measured = (text: string) => {
      let searches = 0, searched = 0, inspected = 0;
      const searching = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, needle: string, from = 0) {
        const at = find.call(this, needle, from);
        if (this === text && needle === '://') {
          searches += 1;
          searched += (at < 0 ? text.length : at + needle.length) - from;
        }
        return at;
      });
      const reading = vi.spyOn(String.prototype, 'charAt').mockImplementation(function (this: string, at: number) {
        if (this === text) inspected += 1;
        return read.call(this, at);
      });
      try {
        return { text: hideCredentials(text), searches, steps: searched + inspected };
      } finally {
        searching.mockRestore();
        reading.mockRestore();
      }
    };
    const sizes = [2048, 4096];
    const plain = sizes.map(size => measured('f'.repeat(size)));
    for (const [i, result] of plain.entries()) {
      expect(result.text).toBe('f'.repeat(sizes[i]!));
      expect(result.searches).toBe(1);
      expect(result.steps).toBe(sizes[i]);
    }
    const urls = sizes.map(size => measured(`${'f'.repeat(size)}://user:pass@host.example`));
    for (const [i, result] of urls.entries()) {
      expect(result.text).toBe(`${'f'.repeat(sizes[i]!)}://${HIDDEN}@host.example`);
      expect(result.searches).toBe(2);
      expect(result.steps).toBeLessThanOrEqual(2 * sizes[i]! + 32);
    }
    expect(urls[1]!.steps).toBeLessThanOrEqual(2 * urls[0]!.steps);
  });
});

describe('a diagnostic cleaned for a reader who may not read where it comes from', () => {
  it('hides labelled Russian passwords and keeps ordinary prose and identifiers', () => {
    expect(hiddenBy('пароль: "two words"; password = test123!\nПароль qwerty123!', CREDENTIALS)).toBe('пароль: [hidden]; password = [hidden]\nПароль [hidden]');
    for (const plain of ['Change the password tomorrow', 'Сменить пароль завтра', 'Reset password', 'task #267', 'd44ecb8c7d3d0b6d7ce690e01c25046f0404b212', 'e5cd054b-2620-421c-b07b-546bfbcdbedf']) {
      expect(hiddenBy(plain, CREDENTIALS)).toBe(plain);
    }
  });
  it('hides credentials by their shape', () => {
    const cases: [string, string][] = [
      ['token ghp_abcDEF0123456789abcdef0123 refused', `token ${HIDDEN} refused`],
      ['key sk-ant-api03-abcdefgh_ijkl-mnop failed', `key ${HIDDEN} failed`],
      ['github_pat_11ABC_def0123 expired', `${HIDDEN} expired`],
      ['user AKIAABCDEFGHIJKLMNOP', `user ${HIDDEN}`],
      ['sent eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw', `sent ${HIDDEN}`],
      ['Authorization: Bearer abc.def\nnext line', `${HIDDEN}\nnext line`],
      ['curl -H x Bearer abcdef0123', `curl -H x ${HIDDEN}`],
      ['password=hunter22 token: "a b c"', `password=${HIDDEN} token: ${HIDDEN}`],
      ['run --token s3cr3tvalue now', `run --token ${HIDDEN} now`],
      ['GET /cb?code=abc123&state=ok', `GET /cb?code=${HIDDEN}&state=ok`],
      ['https://bruno:pa55word@github.com/acme/app.git', `https://${HIDDEN}@github.com/acme/app.git`],
      ['-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- done', `${HIDDEN} done`],
    ];
    for (const [text, clean] of cases) expect(cleanDiagnostic(text), text).toBe(clean);
  });

  it('hides paths in a home or user folder, and keeps the rest', () => {
    const cases: [string, string][] = [
      ['Cannot load /home/alex/project/.env', `Cannot load ${HIDDEN}`],
      ['open "/Users/maya/keys/id_rsa" failed', `open "${HIDDEN}" failed`],
      ['in /root/.npmrc', `in ${HIDDEN}`],
      ['HOME=/data/home/agent and /var/home/x', `HOME=${HIDDEN} and ${HIDDEN}`],
      ['at C:\\Users\\alex\\.ssh\\id_rsa', `at ${HIDDEN}`],
      ['the home of /home', `the home of ${HIDDEN}`],
    ];
    for (const [text, clean] of cases) expect(cleanDiagnostic(text), text).toBe(clean);
    for (const kept of [
      'apps/web/e2e/agent-state-1.spec.ts failed',
      'Cannot find module /app/apps/node/dist/test-impact-mutation.js',
      'cd /data/work/agents/3f1/hornhoof && npm test',
      'see https://example.com/home/page and ~/project',
      'the /homework folder and /rooted paths',
      'commit 5989973ddde9b758474401009c791623fd4a5bca passed',
    ]) expect(cleanDiagnostic(kept), kept).toBe(kept);
  });

  it('keeps each list to its own kind, so the node log hides credentials and leaves its paths', () => {
    expect(hiddenBy('token=abc in /home/alex/x', CREDENTIALS)).toBe(`token=${HIDDEN} in /home/alex/x`);
    expect(hiddenBy('token=abc in /home/alex/x', PRIVATE_PATHS)).toBe(`token=abc in ${HIDDEN}`);
    expect(hiddenBy('nothing here', [])).toBe('nothing here');
  });

  it('leaves no part of a credential at the edge of a cut made after cleaning', () => {
    const token = 'ghp_' + 'abcdefghij'.repeat(4);
    const text = `start ${token} ` + 'y'.repeat(20);
    expect(text.slice(-30).startsWith(token.slice(-9))).toBe(true);
    expect(cleanDiagnostic(text)).toBe(`start ${HIDDEN} ${'y'.repeat(20)}`);
    expect(cleanDiagnostic(text).slice(-30)).not.toContain(token.slice(-9));
  });
});
