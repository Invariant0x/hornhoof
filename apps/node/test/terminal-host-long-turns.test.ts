import { afterEach, describe, expect, it } from 'vitest';
import { SECRET, hasTmux, until, host, sent, setUp, job } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('lets a turn run past the time it was given, until it is called off', async () => {
    await setUp();
    await host.run(job('a5', 'warm up'));
    const stop = new AbortController();
    let over = false;
    const running = host.run(job('a5', 'HANG', { timeoutMs: 300, signal: stop.signal })).finally(() => (over = true));
    await new Promise(r => setTimeout(r, 1500));
    expect(over).toBe(false);
    stop.abort();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it("types Hornhoof's words into a running turn, which takes them in, and says when no turn runs", async () => {
    await setUp();
    await host.run(job('a7', 'warm up'));
    const running = host.run(job('a7', 'HANG'));
    await until(async () => {
      const screen = await host.screen('a7');
      return screen.includes('HANG') && screen.trimEnd().endsWith('❯');
    });
    expect(await host.say('a7', 'SLOW Use the new schema.')).toBe(true);
    expect(await running).toMatchObject({ ok: true, result: 'echo: SLOW Use the new schema.' });
    expect(sent.filter(m => m.type === 'turn.open')).toEqual([]);
    expect(await host.say('a7', 'Nobody works now.')).toBe(false);
    expect(await host.say('nobody', 'Hello.')).toBe(false);
  });

  it("does not type Hornhoof's words into a program whose turn already ended, so they get the next turn", async () => {
    await setUp();
    await host.run(job('a13', 'warm up'));
    /* The program ended its turn; the host still reads the rest of its log. */
    const running = host.run(job('a13', 'LAGLONG one'));
    await until(async () => (await host.screen('a13')).includes('echo: LAGLONG one'));
    await new Promise(r => setTimeout(r, 300));
    expect(await host.say('a13', 'Use the new schema.')).toBe(false);
    expect(await running).toMatchObject({ ok: true, result: 'echo: LAGLONG one' });
    expect(await host.screen('a13')).not.toContain('echo: Use the new schema.');
  });

  it('opens a turn for what a person typed right after a turn ended, while the host still read its log', async () => {
    await setUp();
    await host.run(job('a14', 'warm up'));
    await host.open({ type: 'term.open', termId: 'w14', agentKey: 'a14', cols: 80, rows: 24, write: true });
    const running = host.run(job('a14', 'LAGLONG one'));
    await until(async () => (await host.screen('a14')).includes('echo: LAGLONG one'));
    await new Promise(r => setTimeout(r, 300));
    host.input({ type: 'term.input', termId: 'w14', data: 'typed after\r' });
    await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'a14' && m.text === 'typed after'));
    expect(await running).toMatchObject({ ok: true, result: 'echo: LAGLONG one' });
  });

  it("does not type Hornhoof's words before the turn's own prompt went in, so they get the next turn", async () => {
    await setUp({ enterWaitMs: 200 });
    const running = host.run(job('a12', 'hello', { env: { FAKE_SECRET: SECRET, FAKE_START_MS: '2500' } }));
    await new Promise(r => setTimeout(r, 300));
    expect(await host.say('a12', 'Use the new schema.')).toBe(false);
    expect(await running).toMatchObject({ ok: true, result: 'echo: hello' });
  });
});
