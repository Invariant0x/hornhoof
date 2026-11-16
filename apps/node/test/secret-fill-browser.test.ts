import { sameSite, type FillField } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { browserFillAdapter, type BrowserFillDeps, type FillContext, type FillPage } from '../src/secret-fill/browser.js';
import { SecretValue, type FillValues } from '../src/secret-fill/index.js';

const PASSWORD = 'pw-marker-c0ffee71';
const CODE = '402913';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* One screen of a recorded sign-in: the page's address, the sign-in fields it shows and what it says. Enter on a field
   goes to the screen named for it. */
type Screen = { url: string; login?: boolean; password?: boolean; code?: boolean; robot?: boolean; refused?: boolean; next?: string };

function recorded(screens: Record<string, Screen>, first: string) {
  const typed: { field: string; value: string; on: string }[] = [];
  const shots: { masks: string[]; on: string }[] = [];
  const events: string[] = [];
  let current = first;
  const page: FillPage = {
    url: () => screens[current]!.url,
    goto: async url => void events.push(`goto ${url}`),
    evaluate: async () => {
      const s = screens[current]!;
      return { login: Boolean(s.login), password: Boolean(s.password), code: Boolean(s.code), robot: Boolean(s.robot), refused: Boolean(s.refused) };
    },
    locator: selector => ({
      selector,
      fill: async value => void typed.push({ field: /"(\w+)"/.exec(selector)![1]!, value, on: current }),
      press: async () => {
        events.push(`enter on ${current}`);
        current = screens[current]!.next ?? current;
      },
    }),
    waitForLoadState: async () => {},
    screenshot: async options => {
      shots.push({ masks: options.mask.map(m => m.selector), on: current });
      return PNG;
    },
  };
  let closed = 0;
  const context: FillContext = {
    pages: () => [page],
    newPage: async () => page,
    storageState: async () => ({ cookies: [{ name: 'sid', value: 'session-cookie-9f9f', domain: '.partner.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }),
    close: async () => void closed++,
  };
  const deps: BrowserFillDeps = {
    launcher: () => ({ launchPersistentContext: async () => context }),
    lookup: async () => ['93.184.215.14'],
    tmp: '/tmp',
    uid: 1000,
    pid: 4242,
    table: { pids: () => [], args: () => null, group: () => null, owner: () => null, alive: () => false, kill: () => {} },
    folders: { list: () => [], owner: () => null, remove: () => {} },
    makeDir: prefix => `${prefix}x`,
    removeDir: () => void events.push('removed'),
    secret: () => 'proxy-secret',
    listen: async () => 0,
  };
  return { deps, typed, shots, events, closed: () => closed };
}

const values = (code: string | null = CODE): FillValues => ({ login: new SecretValue('team@acme.test'), password: new SecretValue(PASSWORD), code: () => (code ? new SecretValue(code) : null) });
const all: FillField[] = ['login', 'password', 'code'];
const target = { kind: 'browser' as const, address: 'https://partner.example/login' };
const run = (deps: BrowserFillDeps, fields = all, v = values()) => browserFillAdapter(deps).fill(target, v, fields, new AbortController().signal);

describe('signing in with the node browser', () => {
  it('fills the login, then the password, then the code, step by step, and keeps the sign-in it got', async () => {
    const r = recorded(
      {
        login: { url: 'https://partner.example/login', login: true, next: 'password' },
        password: { url: 'https://partner.example/login/password', password: true, next: 'code' },
        code: { url: 'https://accounts.partner.example/2fa', code: true, next: 'home' },
        home: { url: 'https://partner.example/home' },
      },
      'login',
    );
    const done = await run(r.deps);
    expect(done.status).toBe('signed_in');
    expect(done.filled).toEqual(['login', 'password', 'code']);
    expect(r.typed).toEqual([
      { field: 'login', value: 'team@acme.test', on: 'login' },
      { field: 'password', value: PASSWORD, on: 'password' },
      { field: 'code', value: CODE, on: 'code' },
    ]);
    expect(done.session?.cookies[0]?.name).toBe('sid');
    expect(r.closed()).toBe(1);
    expect(r.events).toContain('removed');
  });

  it('fills login and password shown together in one step', async () => {
    const r = recorded({ form: { url: 'https://partner.example/login', login: true, password: true, next: 'home' }, home: { url: 'https://partner.example/' } }, 'form');
    const done = await run(r.deps, ['login', 'password']);
    expect(done).toMatchObject({ status: 'signed_in', filled: ['login', 'password'] });
    expect(r.events.filter(e => e.startsWith('enter'))).toEqual(['enter on form']);
  });

  it('says rejected when the site shows the same fields again after they were sent', async () => {
    const r = recorded({ form: { url: 'https://partner.example/login', login: true, password: true } }, 'form');
    const done = await run(r.deps, ['login', 'password']);
    expect(done.status).toBe('rejected');
  });

  it('stops at a robot check, at a page that refuses the browser and at a step it does not know, with a masked screenshot', async () => {
    const robot = recorded({ a: { url: 'https://partner.example/login', login: true, next: 'b' }, b: { url: 'https://partner.example/check', robot: true } }, 'a');
    const robotDone = await run(robot.deps);
    expect(robotDone.status).toBe('robot_check');
    expect(robotDone.shot).toBe(PNG.toString('base64'));
    expect(robot.shots).toEqual([{ masks: ['[data-hh-fill]', 'input[type=password]'], on: 'b' }]);
    const refused = recorded({ a: { url: 'https://partner.example/login', login: true, refused: true } }, 'a');
    expect((await run(refused.deps)).status).toBe('browser_refused');
    expect(refused.typed).toEqual([]);
    const unknown = recorded({ a: { url: 'https://partner.example/login', login: true, next: 'b' }, b: { url: 'https://partner.example/approve', code: true } }, 'a');
    expect((await run(unknown.deps, ['login', 'password'])).status).toBe('needs_person');
  });

  it('types nothing on a page of another site the sign-in sent it to', async () => {
    const r = recorded({ a: { url: 'https://partner.example/login', login: true, next: 'b' }, b: { url: 'https://evil.example/login', password: true } }, 'a');
    const done = await run(r.deps);
    expect(done.status).toBe('needs_person');
    expect(r.typed.map(t => t.field)).toEqual(['login']);
  });

  it('says field_not_found on a page with no sign-in field, and when the entry has no code the page asks for', async () => {
    const none = recorded({ a: { url: 'https://partner.example/' } }, 'a');
    expect((await run(none.deps)).status).toBe('field_not_found');
    const noCode = recorded({ a: { url: 'https://partner.example/2fa', code: true } }, 'a');
    expect((await run(noCode.deps, all, values(null))).status).toBe('field_not_found');
  });

  it('refuses an address that is not public before any browser starts', async () => {
    const r = recorded({ a: { url: 'http://127.0.0.1/login', login: true } }, 'a');
    const done = await browserFillAdapter({ ...r.deps, lookup: async () => ['127.0.0.1'] }).fill({ kind: 'browser', address: 'http://intranet.local/login' }, values(), all, new AbortController().signal);
    expect(done.status).toBe('failed');
    expect(r.events).toEqual([]);
  });

  it('never puts a value in what it answers', async () => {
    const r = recorded({ a: { url: 'https://partner.example/login', login: true, password: true, code: true } }, 'a');
    const done = await run(r.deps);
    expect(JSON.stringify(done)).not.toContain(PASSWORD);
    expect(JSON.stringify(done)).not.toContain(CODE);
  });
});

describe('the site a sign-in may type into', () => {
  it.each([
    ['https://partner.example/login', 'https://partner.example/other', true],
    ['https://partner.example/login', 'https://accounts.partner.example/', true],
    ['https://www.partner.example/login', 'https://partner.example/', true],
    ['https://partner.example/login', 'https://evil.example/', false],
    ['https://partner.example/login', 'https://partner.example.evil.test/', false],
    ['https://partner.example/login', 'http://partner.example/', false],
  ])('%s and %s: %s', (a, b, same) => {
    expect(sameSite(a, b)).toBe(same);
  });
});
