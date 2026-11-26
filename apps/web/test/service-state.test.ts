import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../src/connection';
import { messageOf, SERVICE_LINES, service, type Inputs } from '../src/service-state';

/* The one road of service messages (#2098, #2099, Design #2100): which state is the current one, and where it stands on its
   way from the window to the strip to gone. The page's other parts only draw what it says. */

const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update.', reason: 'maintenance' } };

const none: Inputs = { online: true, away: null, updating: false, signedOut: false, notices: [] };
const with_ = (over: Partial<Inputs>): Inputs => ({ ...none, ...over });

describe('which state is the current one', () => {
  it('says nothing while nothing is wrong', () => {
    expect(messageOf(none)).toBeNull();
  });

  it('puts the states in one order of importance, one message at a time', () => {
    const all = with_({ online: false, away: 'updating', updating: true, signedOut: true, notices: [{ id: 'n', line: 'A notice' }] });
    expect(messageOf(all)?.kind).toBe('updating');
    const afterUpdate = { ...all, away: 'lost' as const, updating: false };
    expect(messageOf(afterUpdate)?.kind).toBe('signedOut');
    expect(messageOf({ ...afterUpdate, signedOut: false })?.kind).toBe('offline');
    expect(messageOf({ ...afterUpdate, signedOut: false, online: true })?.kind).toBe('lost');
    expect(messageOf({ ...afterUpdate, signedOut: false, online: true, away: null })?.kind).toBe('notice');
  });

  it('gives each kind its one English line', () => {
    expect(SERVICE_LINES).toEqual({ offline: 'No internet', lost: 'No connection', updating: 'Updating', signedOut: 'Signed out' });
    expect(messageOf(with_({ online: false }))).toMatchObject({ kind: 'offline', line: 'No internet' });
    expect(messageOf(with_({ away: 'lost' }))).toMatchObject({ kind: 'lost', line: 'No connection' });
    expect(messageOf(with_({ signedOut: true }))).toMatchObject({ kind: 'signedOut', line: 'Signed out' });
    expect(messageOf(with_({ updating: true }))).toMatchObject({ kind: 'updating', line: 'Updating' });
  });

  it('reads a lost server as an update while one runs or when the server says it is updating', () => {
    expect(messageOf(with_({ away: 'lost', updating: true }))?.kind).toBe('updating');
    expect(messageOf(with_({ away: 'updating' }))?.kind).toBe('updating');
  });

  it('shows the first notice of several, in the order they came', () => {
    const notices = [{ id: 'a', line: 'First' }, { id: 'b', line: 'Second' }];
    expect(messageOf(with_({ notices }))?.line).toBe('First');
  });
});

describe('the way of a state: window, strip, gone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    service.reset();
    connection.reset();
  });

  afterEach(() => {
    service.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const lose = async (why: 'lost' | 'updating' = 'lost') => {
    vi.stubGlobal('fetch', vi.fn(() => (why === 'lost' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(JSON.stringify(MAINTENANCE), { status: 503 })))));
    connection.lost(why);
    await vi.advanceTimersByTimeAsync(0);
  };
  const serverBack = async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"build":"b1"}', { status: 200 })));
    connection.tryNow();
    await vi.advanceTimersByTimeAsync(0);
  };
  const browserOnline = (on: boolean) => {
    vi.stubGlobal('navigator', { ...navigator, onLine: on });
    window.dispatchEvent(new Event(on ? 'online' : 'offline'));
  };

  it('shows nothing before anything is wrong', () => {
    expect(service.snapshot()).toBeNull();
  });

  it('comes as the window, lives on as the strip once the window is closed, and goes by itself when the state ends', async () => {
    await lose();
    expect(service.snapshot()).toMatchObject({ place: 'window', message: { kind: 'lost', line: SERVICE_LINES.lost } });

    service.close();
    expect(service.snapshot()).toMatchObject({ place: 'strip', message: { kind: 'lost' } });

    await serverBack();
    expect(service.snapshot()).toBeNull();
  });

  it('is one place at a time, never the window and the strip together', async () => {
    await lose();
    const seen: string[] = [];
    service.subscribe(() => seen.push(service.snapshot()?.place ?? 'none'));
    service.close();
    await serverBack();
    expect(seen).toEqual(['strip', 'none']);
  });

  it('starts over with the window for the next time the same state comes', async () => {
    await lose();
    service.close();
    await serverBack();
    /* A request that fails right after a look found the server is no reason to look again: the next outage comes later. */
    await vi.advanceTimersByTimeAsync(6_000);
    await lose();
    expect(service.snapshot()?.place).toBe('window');
  });

  it('ignores a close when nothing shows', () => {
    service.close();
    expect(service.snapshot()).toBeNull();
  });

  it('keeps the same view object while nothing changed, and tells its watchers once per change', async () => {
    const watcher = vi.fn();
    service.subscribe(watcher);
    await lose();
    const first = service.snapshot();
    expect(service.snapshot()).toBe(first);
    expect(watcher).toHaveBeenCalledTimes(1);
    /* A look that found the server still away changes nothing the page draws. */
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.snapshot()).toBe(first);
    expect(watcher).toHaveBeenCalledTimes(1);
  });

  it('shows only the boot screen through an update; dismissing does nothing', () => {
    service.setUpdate(true);
    expect(service.snapshot()).toMatchObject({ place: 'boot', message: { kind: 'updating' } });

    service.close();
    expect(service.snapshot()?.place).toBe('boot');

    service.setUpdate(false);
    expect(service.snapshot()).toBeNull();
  });

  it('keeps the update on the boot screen until the server and the updater are back', async () => {
    service.setUpdate(true);
    await lose('updating');
    expect(service.snapshot()).toMatchObject({ place: 'boot', message: { kind: 'updating' } });
    await serverBack();
    expect(service.snapshot()?.place).toBe('boot');
    service.setUpdate(false);
    expect(service.snapshot()).toBeNull();
  });

  it('brings a more important state as a window, and gives the one under it back as the strip it was', async () => {
    await lose();
    service.close();
    expect(service.snapshot()?.place).toBe('strip');

    /* The browser itself loses the network: a more important state, which comes as its own window. */
    browserOnline(false);
    expect(service.snapshot()).toMatchObject({ place: 'window', message: { kind: 'offline', line: SERVICE_LINES.offline } });

    /* It ends: the server is still away, and the person already closed the window of that, so it stays a strip. */
    browserOnline(true);
    expect(service.snapshot()).toMatchObject({ place: 'strip', message: { kind: 'lost' } });
  });

  it('keeps the strip for connection loss when a lower-priority notice arrives', async () => {
    await lose();
    service.close();
    service.notify('relay', 'A notice');
    expect(service.snapshot()).toMatchObject({ place: 'strip', message: { kind: 'lost' } });
    await serverBack();
    expect(service.snapshot()).toBeNull();
    service.clear('relay');
    expect(service.snapshot()).toBeNull();
  });

  it('asks the server at once when the browser says it is online again', async () => {
    await lose();
    const look = vi.fn(async () => new Response('{"build":"b1"}', { status: 200 }));
    vi.stubGlobal('fetch', look);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(look).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toBeNull();
  });

  it('shows being signed out above everything else, until the person is signed in again', () => {
    browserOnline(false);
    service.close();
    service.signedOut(true);
    expect(service.snapshot()).toMatchObject({ place: 'window', message: { kind: 'signedOut', line: SERVICE_LINES.signedOut } });
    service.close();
    expect(service.snapshot()).toBeNull();
    service.signedOut(false);
    expect(service.snapshot()).toMatchObject({ message: { kind: 'offline' } });
    browserOnline(true);
    expect(service.snapshot()).toBeNull();
  });

  it('takes any other service notice by its id, once, and drops it when it is cleared', () => {
    service.notify('relay', 'The relay is away');
    service.notify('relay', 'The relay is away');
    expect(service.snapshot()).toMatchObject({ place: 'window', message: { kind: 'notice', line: 'The relay is away' } });
    service.clear('relay');
    expect(service.snapshot()).toBeNull();
  });

  it('knows whether a page area shows the loader line in its own place, which each area holds and lets go', async () => {
    await lose();
    service.close();
    expect(service.snapshot()?.loader).toBe(false);
    const first = service.holdLoader();
    const second = service.holdLoader();
    expect(service.snapshot()?.loader).toBe(true);
    first();
    first();
    expect(service.snapshot()?.loader).toBe(true);
    second();
    expect(service.snapshot()?.loader).toBe(false);
  });
});
