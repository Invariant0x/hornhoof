import { describe, expect, it } from 'vitest';
import { HookCalls } from '../src/terminal/hook-calls.js';

describe('recent hook calls', () => {
  it('keeps recent stops through status traffic and isolates agents', async () => {
    const calls = new HookCalls();
    let applied = 0;
    const apply = async () => String(++applied);
    expect(await calls.run('one', 'stop', 'last-stop', apply)).toEqual({ status: 200, text: '1' });
    for (let i = 0; i < 1025; i++) await calls.run('one', 'status', `status-${i}`, async () => '');
    expect(await calls.run('one', 'stop', 'last-stop', apply)).toEqual({ status: 200, text: '1' });
    expect(await calls.run('two', 'stop', 'last-stop', apply)).toEqual({ status: 200, text: '2' });
    expect(await calls.run('one', 'prompt', 'last-stop', apply)).toEqual({ status: 409, text: '' });
    expect(applied).toBe(2);
  });

  it('retains 1024 completed stops and then admits a new stop', async () => {
    const calls = new HookCalls();
    for (let i = 0; i < 1025; i++) expect((await calls.run('one', 'stop', `stop-${i}`, async () => String(i))).status).toBe(200);
    let applied = false;
    expect(await calls.run('one', 'stop', 'stop-1', async () => { applied = true;return ''; })).toEqual({ status: 200, text: '1' });
    expect(applied).toBe(false);
    expect(await calls.run('one', 'stop', 'stop-0', async () => 'expired')).toEqual({ status: 200, text: 'expired' });
  });

  it('never evicts an unfinished stop to accept another one', async () => {
    const calls = new HookCalls();
    let release!: () => void;
    const wait = new Promise<void>(r => release = r);
    const pending = Array.from({ length: 1024 }, (_, i) => calls.run('one', 'stop', `stop-${i}`, async () => { await wait;return 'accepted'; }));
    expect(await calls.run('one', 'stop', 'overflow', async () => 'must not apply')).toEqual({ status: 429, text: '' });
    const retry = calls.run('one', 'stop', 'stop-0', async () => 'must not apply');
    release();
    expect(await retry).toEqual({ status: 200, text: 'accepted' });
    await Promise.all(pending);
    expect(await calls.run('one', 'stop', 'overflow', async () => 'new')).toEqual({ status: 200, text: 'new' });
  });
});
