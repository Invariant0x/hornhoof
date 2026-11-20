import { act, render, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetOrg, useOrg } from '../src/org';
import { useDecisions } from '../src/tasks';
import type { Org } from '../src/types';
import { DEV_ORG, mockApi, ORG } from './api-mock';
import { fakeStream } from './fake-stream';

const working = (n: number): Org => ({ ...ORG, agents: { ...ORG.agents, working: n } });
const brunoContext = (org: Org | null) => org?.departments[0]?.employees[1]?.context;

/* /api/org answers with each company in turn; a company given as null waits until let go with the one after it. */
function serve(...answers: (Org | null)[]) {
  const waiting: (() => void)[] = [];
  let next = 0;
  mockApi({
    'GET /api/org': () => {
      const answer = answers[Math.min(next++, answers.length - 1)];
      if (answer) return [200, answer];
      const later = answers[next] ?? ORG;
      next++;
      return new Promise(resolve => waiting.push(() => resolve([200, later])));
    },
  });
  return () => act(async () => {
    for (const go of waiting.splice(0)) go();
    /* One turn of the event loop: the answer's promise chain has no timer in it, so it has run its course. */
    await new Promise(r => setImmediate(r));
  });
}

describe('the company every screen shows', () => {
  it('is on a screen that opens again from its first drawing, while that screen asks for it again', async () => {
    fakeStream();
    serve(working(1), null);
    const first = renderHook(() => useOrg());
    await waitFor(() => expect(first.result.current.org).toEqual(working(1)));
    first.unmount();
    const drawn: (Org | null)[] = [];
    renderHook(() => drawn.push(useOrg().org));
    expect(drawn[0]).toEqual(working(1));
  });

  it('comes to a screen that does not ask for it yet, once another screen has it', async () => {
    fakeStream();
    serve(working(1));
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    expect(idle.result.current.org).toEqual(working(1));
  });

  it('stays the newest on every screen when an older answer to another screen comes after it', async () => {
    fakeStream();
    const letGo = serve(null, working(1), working(2));
    const slow = renderHook(() => useOrg());
    const quick = renderHook(() => useOrg());
    await waitFor(() => expect(quick.result.current.org).toEqual(working(2)));
    expect(slow.result.current.org).toEqual(working(2));
    await letGo();
    expect(slow.result.current.org).toEqual(working(2));
    expect(quick.result.current.org).toEqual(working(2));
  });

  it('stays on every screen when an answer comes cut off', async () => {
    const stream = fakeStream();
    let cut = false;
    mockApi({ 'GET /api/org': () => (cut ? [200] : [200, working(1)]) });
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    cut = true;
    stream.send({ type: 'org' });
    await act(async () => {
      /* One turn of the event loop: the answer's promise chain has no timer in it, so it has run its course. */
      await new Promise(r => setImmediate(r));
    });
    expect(asking.result.current).toEqual({ org: working(1), failure: null, load: expect.any(Function) });
    expect(idle.result.current.org).toEqual(working(1));
  });

  it('is forgotten when the person signs out, with the answer still on its way for them', async () => {
    fakeStream();
    const letGo = serve(working(1), null, working(2), null);
    const first = renderHook(() => useOrg());
    await waitFor(() => expect(first.result.current.org).toEqual(working(1)));
    first.unmount();
    const leaving = renderHook(() => useOrg());
    leaving.unmount();
    forgetOrg();
    await letGo();
    const next = renderHook(() => useOrg());
    expect(next.result.current.org).toBeNull();
  });

  it('leaves a screen that drew it just before it was forgotten, though that screen did not watch it yet', async () => {
    fakeStream();
    serve(working(1), null);
    const first = renderHook(() => useOrg());
    await waitFor(() => expect(first.result.current.org).toEqual(working(1)));
    first.unmount();
    /* Effects run in the order of the screen: this one forgets before the next one watches. */
    function Leaving() {
      useEffect(() => forgetOrg(), []);
      return null;
    }
    const drawn: (Org | null)[] = [];
    function Showing() {
      drawn.push(useOrg(false).org);
      return null;
    }
    render(<><Leaving /><Showing /></>);
    expect(drawn[0]).toEqual(working(1));
    expect(drawn.at(-1)).toBeNull();
  });

  it('is forgotten at once on every screen that shows it, asking or not', async () => {
    fakeStream();
    serve(working(1));
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    act(() => forgetOrg());
    expect(asking.result.current).toEqual({ org: null, failure: null, load: expect.any(Function) });
    expect(idle.result.current.org).toBeNull();
  });

  it('keeps the context the stream said of an agent for every screen, asking or not, and for the next one', async () => {
    const stream = fakeStream();
    let held = false;
    mockApi({ 'GET /api/org': () => (held ? new Promise(() => {}) : [200, DEV_ORG]) });
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(DEV_ORG));
    held = true;
    stream.send({ type: 'context', agentId: 'b1', used: 0.75 });
    expect(brunoContext(asking.result.current.org)).toBe(0.75);
    expect(brunoContext(idle.result.current.org)).toBe(0.75);
    asking.unmount();
    idle.unmount();
    const next = renderHook(() => useOrg());
    expect(brunoContext(next.result.current.org)).toBe(0.75);
  });

  it('keeps the working count the stream said for every screen, asking or not, and for the next one', async () => {
    const stream = fakeStream();
    let held = false;
    mockApi({ 'GET /api/org': () => (held ? new Promise(() => {}) : [200, working(1)]) });
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    held = true;
    stream.send({ type: 'working', working: 2 });
    expect(asking.result.current.org).toEqual(working(2));
    expect(idle.result.current.org).toEqual(working(2));
    asking.unmount();
    idle.unmount();
    const next = renderHook(() => useOrg());
    expect(next.result.current.org).toEqual(working(2));
  });

  it('hears nothing more from the stream once no screen shows the company', async () => {
    const stream = fakeStream();
    serve(working(1));
    const idle = renderHook(() => useOrg(false), { wrapper: StrictMode });
    const asking = renderHook(() => useOrg(), { wrapper: StrictMode });
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    idle.unmount();
    asking.unmount();
    expect(stream.sources().length).toBeGreaterThan(0);
    expect(stream.sources().filter(source => !source.closed)).toEqual([]);
  });

  it('brings no company back from the stream once it is forgotten', async () => {
    const stream = fakeStream();
    serve(DEV_ORG, null);
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(DEV_ORG));
    act(() => forgetOrg());
    stream.send({ type: 'context', agentId: 'b1', used: 0.75 });
    stream.send({ type: 'working', working: 2 });
    expect(asking.result.current.org).toBeNull();
    expect(renderHook(() => useOrg(false)).result.current.org).toBeNull();
  });
});

/* A company of 120 agents says a lot at once: who works, what each task and question did, and that the company moved. */
const burst = [
  ...Array.from({ length: 60 }, (_, i) => ({ type: 'working', working: 1 + (i % 5) })),
  ...Array.from({ length: 40 }, () => ({ type: 'task' })),
  ...Array.from({ length: 40 }, () => ({ type: 'requests' })),
  ...Array.from({ length: 20 }, () => ({ type: 'org' })),
];

describe('a burst of the stream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the company a few times for all the screens that show it, not once a message on each screen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/org': [200, working(1)] });
    const screens = [renderHook(() => useOrg()), renderHook(() => useOrg()), renderHook(() => useOrg(false))];
    await act(async () => {});
    const before = calls.filter(c => c.path === '/api/org').length;
    for (const m of burst) stream.send(m);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls.filter(c => c.path === '/api/org').length - before).toBeLessThanOrEqual(3);
    for (const s of screens) s.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells every screen that asks when the request the stream made for them failed, and not a screen that does not ask', async () => {
    const stream = fakeStream();
    let down = false;
    mockApi({ 'GET /api/org': () => (down ? [500, { error: { code: 'internal', message: 'Down.' } }] : [200, working(1)]) });
    const asking = [renderHook(() => useOrg()), renderHook(() => useOrg())];
    const idle = renderHook(() => useOrg(false));
    await waitFor(() => expect(asking[0]!.result.current.org).toEqual(working(1)));
    down = true;
    stream.send({ type: 'org' });
    await waitFor(() => expect(asking.every(s => s.result.current.failure !== null)).toBe(true));
    expect(idle.result.current.failure).toBeNull();
    expect(asking[0]!.result.current.org).toEqual(working(1));
  });

  it('fetches what waits for people a few times, not once a message', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/requests': [200, { requests: [], proposals: [], computerAccess: null, counts: { byPerson: {}, byAgent: {}, total: 0 } }] });
    const decisions = renderHook(() => useDecisions());
    await act(async () => {});
    const before = calls.filter(c => c.path === '/api/requests').length;
    for (const m of burst) stream.send(m);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls.filter(c => c.path === '/api/requests').length - before).toBeLessThanOrEqual(2);
    decisions.unmount();
  });
});
