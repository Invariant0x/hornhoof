import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import type { WindowPlace } from '../src/screens/AgentWindowLayout';
import type { EventView, OrchestratorState } from '../src/types';
import { CARD, DEV_ORG, ME, mockApi } from './api-mock';
import { fakeStream } from './fake-stream';
import { RULES } from './css';

/* A chat opens on its newest line from the first frame it shows, with nothing moving; a person reading higher up stays where
   they read while the chat is open. Time is fake: no frame is ever drawn and no timer runs unless a test moves the clock. */

const EVENTS = '/api/agents/b1/events';
const READY: OrchestratorState = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const BUSY: OrchestratorState = { ...READY, busy: true, runningJobId: 'j1' };
/* The most events the server sends at a time. */
const PAGE = 500;
/* How long the window waits to catch up after a live sign of work. */
const CATCH_UP_MS = 300;
const LINE = 100;
const VIEW = 300;

const ev = (seq: number): EventView => ({ seq, kind: 'text', data: { kind: 'text', text: `Line ${seq}` }, jobId: 'j1', person: null, at: '2026-11-04T10:00:00Z' });
const history = (from: number, count: number) => Array.from({ length: count }, (_, i) => ev(from + i));

const chatLog = () => document.querySelector<HTMLElement>('.t-log.chat');
const lines = (log: HTMLElement) => [...log.children].filter(c => c.classList.contains('t-line'));
const atEnd = (log: HTMLElement) => log.scrollTop >= log.scrollHeight - log.clientHeight;
const shownLog = () => until(() => (chatLog() && !chatLog()!.closest('[hidden]') ? chatLog() : null));

/* Waits for what the page shows next, with no clock: the fake one never runs. Testing Library's own wait ends on a timer, so
   this one only lets React work outside act meanwhile, as that wait does. */
async function until<T>(find: () => T | null): Promise<T> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const before = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await new Promise<T>(done => {
      const look = () => {
        const found = find();
        if (found === null) return;
        watch.disconnect();
        done(found);
      };
      const watch = new MutationObserver(look);
      watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      look();
    });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = before;
  }
}

/* jsdom lays nothing out: here the chat is as tall as its lines, and a hidden window has no size, as in a browser. */
function layOut() {
  const laidOut = (el: HTMLElement) => el.matches('.t-log.chat') && !el.closest('[hidden]');
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return laidOut(this) ? Math.max(VIEW, lines(this).length * LINE) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return laidOut(this) ? VIEW : 0;
  });
}

/* The browser gives a line of the chat its entrance animation once the line shows, and a new one each time a hidden window shows
   again. jsdom has no animations, so this stands in for the browser's: playState says whether the line still moves. */
type Entrance = { playState: AnimationPlayState; finish(): void };
function animations() {
  let playing = new WeakMap<Element, Entrance>();
  const entrance = (el: Element): Entrance[] => {
    if (!el.parentElement?.matches('.t-log.chat') || el.closest('[hidden]')) return [];
    let one = playing.get(el);
    if (!one) {
      one = { playState: 'running', finish() { this.playState = 'finished'; } };
      playing.set(el, one);
    }
    return [one];
  };
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value(this: Element, options?: GetAnimationsOptions) {
      return [...entrance(this), ...(options?.subtree ? [...this.querySelectorAll('*')].flatMap(entrance) : [])];
    },
  });
  onTestFinished(() => {
    delete (Element.prototype as Partial<Element>).getAnimations;
  });
  return {
    moving: (log: HTMLElement) => lines(log).filter(line => entrance(line)[0]?.playState === 'running'),
    /* A hidden element loses its animations; it gets new ones when it shows again. */
    hidden: () => {
      playing = new WeakMap();
    },
  };
}

/* What the chat is like the moment it shows on the page, before any frame or later effect: a mutation is seen right after
   the commit that made it. Set up before the chat shows. */
function firstSight<T>(look: (log: HTMLElement) => T): Promise<T> {
  let seen: T | null = null;
  return until(() => {
    const log = chatLog();
    if (seen === null && log && !log.closest('[hidden]')) seen = look(log);
    return seen;
  });
}

function place(minimized: boolean): WindowPlace {
  return { minimized, dock: null, onMinimize() {}, onRestore() {} };
}

function open(routes: Record<string, unknown>, minimized = false) {
  const calls = mockApi({ 'GET /api/agents/b1': [200, CARD], ...(routes as Record<string, [number, unknown]>) });
  const window = (hidden: boolean) => (
    <LanguageProvider>
      <AgentWindow me={ME} org={DEV_ORG} agentId="b1" onClose={() => {}} place={place(hidden)} />
    </LanguageProvider>
  );
  const view = render(window(minimized));
  return { calls, show: (hidden: boolean) => view.rerender(window(hidden)) };
}

/* The person scrolls the chat to a place higher up. */
function scrollUp(log: HTMLElement, to = LINE) {
  log.scrollTop = to;
  fireEvent.scroll(log);
}

/* The clock is fake from here to the end of the test, after cleanup has checked the timers the window left. */
function virtualTime() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  layOut();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a chat opening', () => {
  it('stands on its newest line, with nothing moving, before its first frame', async () => {
    virtualTime();
    const anim = animations();
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 30), state: READY }] });
    const seen = await firstSight(log => ({ lines: lines(log).length, atEnd: atEnd(log), moving: anim.moving(log).length }));
    expect(seen).toMatchObject({ lines: 30, atEnd: true, moving: 0 });
  });

  it('shows a long history only once all of it is in, at its newest line, not page by page from the top', async () => {
    virtualTime();
    const anim = animations();
    let rest!: (reply: [number, unknown]) => void;
    let asked!: () => void;
    const askedForRest = new Promise<void>(resolve => (asked = resolve));
    open({
      [`GET ${EVENTS}?after=0`]: [200, { events: history(1, PAGE), state: READY }],
      [`GET ${EVENTS}?after=${PAGE}`]: () => {
        asked();
        return new Promise(resolve => (rest = resolve));
      },
    });
    await askedForRest;
    await act(async () => {});
    /* The first page is in, the newest lines are not: the chat does not show its oldest lines meanwhile. */
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.queryByText('Line 1')).not.toBeInTheDocument();
    const sight = firstSight(log => ({ lines: lines(log).length, atEnd: atEnd(log), moving: anim.moving(log).length }));
    rest([200, { events: history(PAGE + 1, 20), state: READY }]);
    expect(await sight).toEqual({ lines: PAGE + 20, atEnd: true, moving: 0 });
  });

  it('keeps scrolling to the browser: the chat asks for no smooth scroll', () => {
    const smooth = RULES.filter(r => r.selectors.some(s => s.includes('.t-log')) && Object.entries(r.decls).some(([k, v]) => k === 'scroll-behavior' && v !== 'auto'));
    expect(smooth).toEqual([]);
  });
});

describe('a chat that is open', () => {
  it('shows a new line that comes while it stands at its end, and lets that line come in', async () => {
    virtualTime();
    const stream = fakeStream();
    const anim = animations();
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 10), state: READY }] });
    const log = await shownLog();
    expect(atEnd(log)).toBe(true);
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(11) });
    expect(lines(log)).toHaveLength(11);
    expect(atEnd(log)).toBe(true);
    /* Only the line that came while the chat was open moves in, at its end. */
    expect(anim.moving(log).map(line => line.textContent)).toEqual([expect.stringContaining('Line 11')]);
  });

  it('leaves a person who scrolled up where they read when a new line comes or the agent starts working', async () => {
    virtualTime();
    const stream = fakeStream();
    let state = READY;
    let more: EventView[] = [];
    open({
      [`GET ${EVENTS}?after=0`]: () => [200, { events: history(1, 10), state }],
      [`GET ${EVENTS}?after=10`]: () => [200, { events: more, state }],
    });
    const log = await shownLog();
    scrollUp(log);
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(11) });
    expect(lines(log)).toHaveLength(11);
    expect(log.scrollTop).toBe(LINE);
    state = BUSY;
    more = [ev(12)];
    stream.send({ type: 'working' });
    await act(async () => vi.advanceTimersByTimeAsync(CATCH_UP_MS));
    await until(() => (lines(log).length === 12 ? log : null));
    expect(screen.getByRole('status', { name: 'Agent state' })).toHaveTextContent('Working on it');
    expect(log.scrollTop).toBe(LINE);
  });

  it('follows new lines again once the person scrolled back down to the end', async () => {
    virtualTime();
    const stream = fakeStream();
    open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 10), state: READY }] });
    const log = await shownLog();
    scrollUp(log);
    scrollUp(log, log.scrollHeight - log.clientHeight);
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(11) });
    expect(atEnd(log)).toBe(true);
  });
});

describe('switching back to a chat', () => {
  it('stands on its newest line, the lines that came while it was hidden included, with nothing moving', async () => {
    virtualTime();
    const stream = fakeStream();
    const anim = animations();
    const { show } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 10), state: READY }] });
    const log = await shownLog();
    /* Another chat is shown: this one hides, and lines keep coming to it. */
    show(true);
    anim.hidden();
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(11) });
    stream.send({ type: 'agent_event', agentId: 'b1', event: ev(12) });
    const sight = firstSight(shown => ({ lines: lines(shown).length, atEnd: atEnd(shown), moving: anim.moving(shown).length }));
    show(false);
    expect(await sight).toEqual({ lines: 12, atEnd: true, moving: 0 });
    expect(chatLog()).toBe(log);
  });

  it('stands on its newest line even when the person had scrolled up in it before switching away', async () => {
    virtualTime();
    const { show } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 10), state: READY }] });
    const log = await shownLog();
    scrollUp(log);
    show(true);
    const sight = firstSight(atEnd);
    show(false);
    expect(await sight).toBe(true);
  });

  it('stands on its newest line when it was hidden before its history came', async () => {
    virtualTime();
    const { show } = open({ [`GET ${EVENTS}?after=0`]: [200, { events: history(1, 10), state: READY }] }, true);
    await until(() => chatLog());
    const sight = firstSight(atEnd);
    show(false);
    expect(await sight).toBe(true);
  });
});
