import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { forgetOrg, useOrg } from '../src/org';
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
    expect(asking.result.current).toEqual({ org: working(1), failure: null });
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

  it('is forgotten at once on every screen that shows it, asking or not', async () => {
    fakeStream();
    serve(working(1));
    const idle = renderHook(() => useOrg(false));
    const asking = renderHook(() => useOrg());
    await waitFor(() => expect(asking.result.current.org).toEqual(working(1)));
    act(() => forgetOrg());
    expect(asking.result.current).toEqual({ org: null, failure: null });
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
