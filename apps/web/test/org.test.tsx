import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { forgetOrg, useOrg } from '../src/org';
import type { Org } from '../src/types';
import { mockApi, ORG } from './api-mock';
import { fakeStream } from './fake-stream';

const working = (n: number): Org => ({ ...ORG, agents: { ...ORG.agents, working: n } });

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
});
