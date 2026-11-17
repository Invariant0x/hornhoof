import { afterEach, describe, expect, it, vi } from 'vitest';
import { done, hasTmux, host, job, sent, setUp, tmux, typeTurn, until } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('a stopped turn followed by a queued letter', () => {
  afterEach(async () => { vi.restoreAllMocks();await host?.stop(); });

  it('keeps the queued reply out of the stopped turn while Escape is still pending', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('stop-letter', 'warm up'));
    const stop = new AbortController();
    const stopped = job('stop-letter', 'HANG', { jobId: 'stopped', sessionId: first.sessionId, signal: stop.signal });
    const running = host.run(stopped);
    await until(() => sent.some(message => message.type === 'job.program' && message.jobId === 'stopped'));
    const pastes = vi.spyOn(tmux, 'paste');
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let escaping = false;
    const keys = tmux.keys.bind(tmux);
    vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => {
      if (pressed.includes('Escape')) { escaping = true;await wait; }
      await keys(name, ...pressed);
    });
    const next = job('stop-letter', 'Answer the queued letter.', { jobId: 'queued', sessionId: first.sessionId });
    stop.abort();
    const queued = host.run(next);
    let went: boolean;
    try {
      await until(() => escaping);
      went = await host.say('stop-letter', 'Answer the queued letter.');
    } finally { release(); }
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await queued).toMatchObject({ ok: true, result: 'echo: Answer the queued letter.' });
    expect(went).toBe(false);
    expect(stopped.events.filter(event => event.kind === 'text')).toEqual([]);
    expect(next.events.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'echo: Answer the queued letter.' }]);
    expect(pastes.mock.calls.map(([, text]) => text)).toEqual(['Answer the queued letter.']);
  });

  it('does not type a cancelled prompt that waited behind the previous turn', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('cancel-waiting', 'warm up'));
    const running = host.run(job('cancel-waiting', 'HANG', { jobId: 'hanging', sessionId: first.sessionId }));
    await until(() => sent.some(message => message.type === 'job.program' && message.jobId === 'hanging'));
    const stop = new AbortController();
    stop.abort();
    const cancelled = host.run(job('cancel-waiting', 'This prompt was cancelled.', { sessionId: first.sessionId, signal: stop.signal }));
    await fetch(host['bridge'].agent('cancel-waiting').hookUrl + '/stop', { method: 'POST', body: '{}' });
    await running;
    expect(await cancelled).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await host.screen('cancel-waiting')).not.toContain('This prompt was cancelled.');
  });

  it('closes a typed turn to new words and events before its Escape finishes', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('typed-stop', 'warm up'));
    await typeTurn('typed-stop', 'typed-view', 'HANG typed', 'typed-job');
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let escaping = false;
    const keys = tmux.keys.bind(tmux);
    vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => {
      if (pressed.includes('Escape')) { escaping = true;await wait; }
      await keys(name, ...pressed);
    });
    const stopping = host.cancel('typed-job');
    let went: boolean;
    try {
      await until(() => escaping);
      expect(done('typed-job')).toMatchObject({ ok: false, error: 'cancelled' });
      went = await host.say('typed-stop', 'Answer the queued letter.');
    } finally { release(); }
    await stopping;
    expect(went).toBe(false);
    expect(done('typed-job')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(sent.filter(message => message.type === 'job.event' && message.jobId === 'typed-job')).toEqual([]);
    expect(await host.run(job('typed-stop', 'Answer the queued letter.', { sessionId: first.sessionId })))
      .toMatchObject({ ok: true, result: 'echo: Answer the queued letter.' });
  });

  it('cancels a queued prompt while the person\'s typed turn continues', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('typed-wait', 'warm up'));
    await typeTurn('typed-wait', 'typed-view', 'HANG typed', 'typed-job');
    const stop = new AbortController();
    const queued = host.run(job('typed-wait', 'Do not type this.', { sessionId: first.sessionId, signal: stop.signal }));
    await new Promise(resolve => setTimeout(resolve, 100));
    stop.abort();
    let result: Awaited<typeof queued> | null = null;
    void queued.then(value => { result = value; });
    await until(() => result !== null, 2000);
    expect(result).toMatchObject({ ok: false, error: 'cancelled' });
    expect(done('typed-job')).toBeUndefined();
    expect(await host.screen('typed-wait')).not.toContain('Do not type this.');
    await host.cancel('typed-job');
  });

  it('waits for the old Escape before typing a new prompt even if the old stop hook arrives first', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('late-escape', 'warm up'));
    await typeTurn('late-escape', 'typed-view', 'HANG typed', 'typed-job');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    let escaping = false;
    const keys = tmux.keys.bind(tmux);
    vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => {
      if (pressed.includes('Escape')) { escaping = true;await gate; }
      await keys(name, ...pressed);
      if (pressed.includes('Escape')) order.push('escaped');
    });
    const paste = tmux.paste.bind(tmux);
    vi.spyOn(tmux, 'paste').mockImplementation(async (name, text) => {
      order.push('pasted');
      await paste(name, text);
    });
    const stopping = host.cancel('typed-job');
    await until(() => escaping);
    const next = host.run(job('late-escape', 'The next letter.', { sessionId: first.sessionId }));
    await new Promise(resolve => setTimeout(resolve, 100));
    await fetch(host['bridge'].agent('late-escape').hookUrl + '/stop', { method: 'POST', body: '{}' });
    try { await new Promise(resolve => setTimeout(resolve, 1000)); }
    finally { release(); }
    await stopping;
    expect(await next).toMatchObject({ ok: true, result: 'echo: The next letter.' });
    expect(order).toEqual(['escaped', 'pasted']);
  });

  it('waits for cancellation requested while the next prompt already awaits the old log', async () => {
    await setUp({ pollMs: 20, enterWaitMs: 100 });
    const first = await host.run(job('settling-escape', 'warm up'));
    await typeTurn('settling-escape', 'typed-view', 'LAGLONG typed', 'typed-job');
    const agent = host['agents'].get('settling-escape')!;
    await until(() => Boolean(agent.settling && !agent.busy));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    let escaping = false;
    const keys = tmux.keys.bind(tmux);
    vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => {
      if (pressed.includes('Escape')) { escaping = true;await gate; }
      await keys(name, ...pressed);
      if (pressed.includes('Escape')) order.push('escaped');
    });
    const paste = tmux.paste.bind(tmux);
    vi.spyOn(tmux, 'paste').mockImplementation(async (name, text) => {
      order.push('pasted');
      await paste(name, text);
    });
    const next = host.run(job('settling-escape', 'The next letter.', { sessionId: first.sessionId }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopping = host.cancel('typed-job');
    try {
      await until(() => escaping);
      await until(() => !agent.settling);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { release(); }
    await stopping;
    expect(await next).toMatchObject({ ok: true, result: 'echo: The next letter.' });
    expect(order).toEqual(['escaped', 'pasted']);
  });
});
