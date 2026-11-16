import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import type { FillField, FillTarget, SecretFill, SecretFilled } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seal, unseal } from '../src/keys.js';
import { forgetExact, holdExact, redact } from '../src/redact.js';
import { FILL_MAX_MS, SecretFills, type FillAdapter, type FillValues } from '../src/secret-fill/index.js';
import { totpCode } from '../src/secret-fill/totp.js';

const PASSWORD = 'pw-marker-5d1e9a';
const TOTP = { secret: 'KRUGS4ZANFZSAYJAONSWG4TFOQQGC3TE', digits: 6, period: 30, algorithm: 'SHA1' } as const;
const START = new Date('2030-01-01T00:00:00Z');

let identity: string;
let recipient: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: START });
  identity ??= await generateX25519Identity();
  recipient ??= await identityToRecipient(identity);
});
afterEach(() => {
  forgetExact();
  vi.useRealTimers();
});

async function request(over: Partial<SecretFill> = {}, plain: object = { login: 'person@example.com', password: PASSWORD, totp: TOTP }): Promise<SecretFill> {
  return {
    type: 'secret.fill',
    requestId: crypto.randomUUID(),
    jobId: null,
    entryId: '10000000-0000-4000-8000-000000000002',
    sealed: await seal(new TextEncoder().encode(JSON.stringify(plain)), [recipient]),
    fields: ['login', 'password', 'code'],
    target: { kind: 'browser', address: 'https://example.com/login' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

type Seen = { order: string[]; typed: Partial<Record<FillField, string>>; released: number };

function setup(fill?: (target: FillTarget, values: FillValues, fields: FillField[], signal: AbortSignal, seen: Seen) => Promise<{ status: 'filled'; filled: FillField[] }>) {
  const sent: SecretFilled[] = [];
  const logs: string[] = [];
  const seen: Seen = { order: [], typed: {}, released: 0 };
  const known = new Set<string>();
  const fills = new SecretFills({
    open: sealed => {
      seen.order.push('open');
      return unseal(sealed, identity);
    },
    hide: (values, until) => {
      seen.order.push('hide');
      for (const v of values) known.add(v);
      holdExact(values, until);
    },
    send: m => void sent.push(m),
    log: line => void logs.push(line),
  });
  const adapter: FillAdapter<'browser'> = {
    kind: 'browser',
    shield: async () => {
      seen.order.push(`shield:${redact(PASSWORD, [...known])}`);
      return async () => void seen.released++;
    },
    fill: async (target, values, fields, signal) => {
      seen.order.push('fill');
      if (fill) return fill(target, values, fields, signal, seen);
      for (const field of fields) {
        const value = field === 'code' ? values.code() : values[field];
        if (value) seen.typed[field] = value.reveal(v => v);
      }
      return { status: 'filled', filled: fields };
    },
  };
  fills.register(adapter);
  return { fills, sent, logs, seen, known };
}

describe('filling a vault sign-in on the node', () => {
  it('opens the values, hides them before the target is touched, types them and answers with a status only', async () => {
    const { fills, sent, seen } = setup();
    const m = await request();
    await fills.handle(m);
    expect(seen.order).toEqual(['open', 'hide', 'hide', 'shield:[hidden]', 'fill', 'hide']);
    expect(seen.typed).toEqual({ login: 'person@example.com', password: PASSWORD, code: totpCode(TOTP, START.getTime()) });
    expect(seen.released).toBe(1);
    expect(sent).toEqual([{ type: 'secret.filled', requestId: m.requestId, status: 'filled', filled: ['login', 'password', 'code'] }]);
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
  });

  it('hides the current code and both neighbours for ten minutes, and the code secret for good', async () => {
    const { fills, known } = setup();
    await fills.handle(await request());
    const code = totpCode(TOTP, START.getTime());
    expect(redact(`code ${code} secret ${TOTP.secret}`, [...known])).toBe('code [hidden] secret [hidden]');
    vi.setSystemTime(START.getTime() + 10 * 60_000 + 1000);
    expect(redact(`code ${code}`, [...known])).toBe(`code ${code}`);
    expect(redact(PASSWORD, [...known])).toBe('[hidden]');
  });

  it('gives no code when the entry has none', async () => {
    const { fills, seen, sent } = setup();
    await fills.handle(await request({}, { login: 'a@example.com', password: PASSWORD, totp: null }));
    expect(seen.typed.code).toBeUndefined();
    expect(sent[0]!.status).toBe('filled');
  });

  it('starts nothing after the fill expired, and opens nothing for a target it does not fill', async () => {
    const { fills, sent, seen } = setup();
    const late = await request({ expiresAt: new Date(Date.now() - 1).toISOString() });
    await fills.handle(late);
    const phone = await request({ target: { kind: 'phone', phoneSessionId: '10000000-0000-4000-8000-000000000004', generation: 1, element: null } });
    await fills.handle(phone);
    expect(sent.map(m => m.status)).toEqual(['expired', 'unsupported']);
    expect(seen.order).toEqual([]);
  });

  it('types nothing from a sealed part that is not for this node, and says so without the value', async () => {
    const { fills, sent, seen, logs } = setup();
    const other = await identityToRecipient(await generateX25519Identity());
    const m = await request();
    m.sealed = await seal(new TextEncoder().encode(JSON.stringify({ login: 'a', password: PASSWORD, totp: null })), [other]);
    await fills.handle(m);
    expect(sent.map(s => s.status)).toEqual(['failed']);
    expect(seen.order).toEqual(['open']);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('answers failed with no words of the adapter when it throws, and still releases the target', async () => {
    const { fills, sent, seen, logs } = setup(async () => {
      throw new Error(`could not type ${PASSWORD}`);
    });
    await fills.handle(await request());
    expect(sent.map(s => s.status)).toEqual(['failed']);
    expect(seen.released).toBe(1);
    expect(JSON.stringify(sent) + logs.join('\n')).not.toContain(PASSWORD);
  });

  it('stops a fill that runs past its limit on the controlled clock and answers expired', async () => {
    let started!: () => void;
    const filling = new Promise<void>(resolve => (started = resolve));
    const { fills, sent, seen } = setup(
      (_t, _v, _f, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          started();
        }),
    );
    const done = fills.handle(await request({ expiresAt: new Date(Date.now() + 120_000).toISOString() }));
    await filling;
    await vi.advanceTimersByTimeAsync(FILL_MAX_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(sent.map(s => s.status)).toEqual(['expired']);
    expect(seen.released).toBe(1);
  });

  it('runs one request once, however often it comes', async () => {
    const { fills, sent } = setup();
    const m = await request();
    await fills.handle(m);
    await fills.handle(m);
    expect(sent).toHaveLength(1);
  });

  it('tells which targets it fills', () => {
    const { fills } = setup();
    expect(fills.kinds()).toEqual(['browser']);
  });
});
