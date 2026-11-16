import { describe, expect, it } from 'vitest';
import { CREDENTIALS, cleanDiagnostic, HIDDEN, hiddenBy, PRIVATE_PATHS } from '../src/redaction.js';

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
