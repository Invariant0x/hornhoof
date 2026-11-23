import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { awayOf, connection, fromAHop } from '../src/connection';

/* The page's idea of whether the server answers (#1938): which answers say it is away, and how the page looks again until it
   answers, on the clock the test moves. */

const said = (reason: string, code = 'unavailable') => ({ error: { code, message: 'x', reason } });
const answer = (status: number, body: unknown) => new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('which answers say the server is away', () => {
  it('reads an answer with none of Hornhoof words that says missing or failed as a hop, and nothing else', () => {
    for (const status of [404, 500, 502, 503, 504, 521]) {
      expect(fromAHop(status, null), String(status)).toBe(true);
      expect(fromAHop(status, 'a page of its own'), String(status)).toBe(true);
      expect(awayOf(status, null)).toBe('lost');
    }
    for (const status of [200, 204, 301, 400, 401, 403, 409, 410, 429]) expect(awayOf(status, null), String(status)).toBeNull();
    /* A body that broke off says nothing of who sent it. */
    expect(fromAHop(502, undefined)).toBe(false);
  });

  it('keeps what the server says in its own words as the server, a 404 included', () => {
    expect(awayOf(404, { error: { code: 'not_found', message: 'Not found.' } })).toBeNull();
    expect(awayOf(500, { error: { code: 'internal', message: 'Something went wrong.' } })).toBeNull();
    expect(awayOf(503, said('read_only'))).toBeNull();
    expect(awayOf(503, said('not_confirmed'))).toBeNull();
  });

  it('reads the front or the keeper speaking for a server that is not there, and an update', () => {
    expect(awayOf(502, said('starting'))).toBe('lost');
    expect(awayOf(503, said('starting'))).toBe('lost');
    expect(awayOf(503, said('no_leader'))).toBe('lost');
    expect(awayOf(503, said('maintenance'))).toBe('updating');
  });
});

describe('looking again until the server answers', () => {
  const asked = () => fetchStub.mock.calls.length;
  let fetchStub: Mock<(path: string) => Promise<Response>>;
  let back: Mock<() => void>;
  let stopBack: () => void;
  /* What the next looks are answered with, the last for every look after it. */
  const answering = (...next: (() => Response)[]) => {
    let at = 0;
    fetchStub.mockImplementation(async () => next[Math.min(at++, next.length - 1)]!());
  };
  const up = () => answer(200, { build: 'b1' });
  const hop = () => answer(404, '<html>Not Found</html>');
  const refusedNow = () => {
    throw new TypeError('Failed to fetch');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fetchStub = vi.fn<(path: string) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchStub);
    back = vi.fn<() => void>();
    stopBack = connection.onBack(back);
  });

  afterEach(() => {
    stopBack();
    vi.useRealTimers();
  });

  it('draws nothing when a request failed alone and the server answers the look', async () => {
    answering(up);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toBe(1);
    expect(fetchStub.mock.calls[0]![0]).toBe('/api/build');
    expect(connection.snapshot().away).toBeNull();
    /* A blip leaves each failed request to say so by itself: no screen is asked to fetch again. */
    expect(back).not.toHaveBeenCalled();
  });

  it('says no connection once the look fails, looks again after a growing wait to a cap, and comes back once', async () => {
    answering(refusedNow, hop, refusedNow, hop, refusedNow, refusedNow, up);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('lost');
    /* Waits of 1, 2, 4, 8 and then 10 seconds. */
    const looks: number[] = [];
    let waited = 0;
    for (const wait of [1000, 2000, 4000, 8000, 10_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(asked(), `before ${wait}`).toBe(looks.length + 1);
      await vi.advanceTimersByTimeAsync(1);
      waited += wait;
      looks.push(waited);
      expect(asked(), `at ${wait}`).toBe(looks.length + 1);
    }
    expect(connection.snapshot().away).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
    /* Nothing is asked again once it answered. */
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked()).toBe(7);
  });

  it('tells when the server was first missed and when the next look comes, and nothing once it answers', async () => {
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    const missed = Date.now();
    answering(refusedNow, refusedNow, up);
    expect(connection.snapshot()).toMatchObject({ since: null, nextAt: null });
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot()).toEqual({ away: 'lost', trying: false, since: missed, nextAt: missed + 1000 });
    /* A look on its way has no next one yet; the second miss keeps the first moment, and the wait doubles. */
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.snapshot()).toEqual({ away: 'lost', trying: false, since: missed, nextAt: missed + 1000 + 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.snapshot()).toEqual({ away: null, trying: false, since: null, nextAt: null });
  });

  it('says an update when a request was refused for one and the server stays away, through the restart that follows', async () => {
    answering(refusedNow, up);
    connection.lost('updating');
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('updating');
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('updating');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.snapshot().away).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('draws nothing for a change refused for an update while reads still go through', async () => {
    answering(up);
    connection.lost('updating');
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBeNull();
    expect(back).not.toHaveBeenCalled();
    /* The next outage is a plain one: what was heard before does not stay. */
    answering(refusedNow);
    await vi.advanceTimersByTimeAsync(5000);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('lost');
  });

  it('says an update when one is known to run and the server cannot be reached', async () => {
    answering(refusedNow);
    connection.updateRuns(true);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('updating');
    connection.updateRuns(false);
    expect(connection.snapshot().away).toBe('lost');
  });

  it('reads an answer in the server own words, a 404 too, as the server back', async () => {
    answering(refusedNow, () => answer(404, { error: { code: 'not_found', message: 'Not found.' } }));
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot().away).toBe('lost');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.snapshot().away).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('looks at once when asked, and starts its waits over', async () => {
    answering(refusedNow, refusedNow, up);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked()).toBe(2);
    connection.tryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toBe(3);
    expect(connection.snapshot().away).toBeNull();
  });

  it('does not look without end for a request that keeps failing while the server answers', async () => {
    answering(up);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    connection.lost();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toBe(2);
  });

  it('tells the page a look is on its way', async () => {
    let finish!: (res: Response) => void;
    fetchStub.mockImplementationOnce(() => new Promise<Response>(resolve => (finish = resolve)));
    connection.lost();
    expect(connection.snapshot().trying).toBe(true);
    finish(hop());
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.snapshot()).toMatchObject({ away: 'lost', trying: false });
  });
});
