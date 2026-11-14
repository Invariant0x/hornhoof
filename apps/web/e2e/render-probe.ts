import type { Page } from '@playwright/test';

/* What the page holds alive at one moment, and what it did since it loaded. */
export type RenderProbe = {
  /* React commits since the page loaded, as React tells devtools of each. */
  commits: number;
  timeouts: number;
  intervals: number;
  frames: number;
  /* Elements a ResizeObserver watches, and the observers that watch any. */
  resizeTargets: number;
  resizeCallbacks: number;
  mutationObservers: number;
  /* Listeners on window, document and every other target that is no element. */
  globalListeners: number;
  streams: number;
  /* WebSockets not yet closed. */
  sockets: number;
  nodes: number;
  xterms: number;
};

type ProbeWindow = Window & {
  __hhProbe(): RenderProbe;
  __hhLive(messages: unknown[]): void;
  __hhLiveApart(messages: unknown[]): Promise<void>;
  __hhListeners(): Record<string, number>;
};

/* Runs in the page before its code: counts what the page holds alive without changing what it does. Stream messages come
   from the test through a stand-in EventSource. */
export function installRenderProbe() {
  const host = window as unknown as ProbeWindow & Record<string, unknown>;
  let commits = 0;
  const hook = {
    renderers: new Map<number, unknown>(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer: unknown) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {
      commits++;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
  host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

  const timeouts = new Set<unknown>();
  const intervals = new Set<unknown>();
  const frames = new Set<number>();
  const setTimeout0 = window.setTimeout.bind(window);
  const clearTimeout0 = window.clearTimeout.bind(window);
  const setInterval0 = window.setInterval.bind(window);
  const clearInterval0 = window.clearInterval.bind(window);
  const raf0 = window.requestAnimationFrame.bind(window);
  const caf0 = window.cancelAnimationFrame.bind(window);
  host.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = setTimeout0((...a: unknown[]) => {
      timeouts.delete(id);
      if (typeof fn === 'function') (fn as (...x: unknown[]) => void)(...a);
    }, ms, ...args);
    timeouts.add(id);
    return id;
  }) as typeof window.setTimeout;
  host.clearTimeout = ((id?: number) => {
    timeouts.delete(id);
    clearTimeout0(id);
  }) as typeof window.clearTimeout;
  host.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = setInterval0(fn, ms, ...args);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  host.clearInterval = ((id?: number) => {
    intervals.delete(id);
    clearInterval0(id);
  }) as typeof window.clearInterval;
  host.requestAnimationFrame = (fn: FrameRequestCallback) => {
    const id = raf0(t => {
      frames.delete(id);
      fn(t);
    });
    frames.add(id);
    return id;
  };
  host.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
    caf0(id);
  };

  let resizeTargets = 0;
  let resizeCallbacks = 0;
  const Resize0 = window.ResizeObserver;
  host.ResizeObserver = class extends Resize0 {
    private readonly watched = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        resizeCallbacks++;
        callback(entries, observer);
      });
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      if (!this.watched.has(target)) {
        this.watched.add(target);
        resizeTargets++;
      }
      super.observe(target, options);
    }
    unobserve(target: Element) {
      if (this.watched.delete(target)) resizeTargets--;
      super.unobserve(target);
    }
    disconnect() {
      resizeTargets -= this.watched.size;
      this.watched.clear();
      super.disconnect();
    }
  };

  let mutationObservers = 0;
  const Mutation0 = window.MutationObserver;
  host.MutationObserver = class extends Mutation0 {
    private watching = false;
    observe(target: Node, options?: MutationObserverInit) {
      if (!this.watching) mutationObservers++;
      this.watching = true;
      super.observe(target, options);
    }
    disconnect() {
      if (this.watching) mutationObservers--;
      this.watching = false;
      super.disconnect();
    }
  };

  /* A listener is one per target, type, function and phase, as the browser keeps it. */
  const listeners = new Map<EventTarget, Set<string>>();
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const idOf = (fn: object) => {
    if (!ids.has(fn)) ids.set(fn, nextId++);
    return ids.get(fn)!;
  };
  const capture = (o: unknown) => (typeof o === 'boolean' ? o : !!(o as { capture?: boolean } | undefined)?.capture);
  const counted = (t: EventTarget) => !(t instanceof Element) && !(t instanceof Text);
  const add0 = EventTarget.prototype.addEventListener;
  const remove0 = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (fn && counted(this)) {
      const set = listeners.get(this) ?? new Set<string>();
      set.add(`${type}|${idOf(fn)}|${capture(options)}`);
      listeners.set(this, set);
      const signal = typeof options === 'object' ? options.signal : undefined;
      signal?.addEventListener('abort', () => set.delete(`${type}|${idOf(fn)}|${capture(options)}`));
    }
    return add0.call(this, type, fn, options);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (fn && counted(this)) listeners.get(this)?.delete(`${type}|${idOf(fn)}|${capture(options)}`);
    return remove0.call(this, type, fn, options);
  };

  const streams: EventTarget[] = [];
  class FakeEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 1;
    constructor() {
      super();
      streams.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  host.EventSource = FakeEventSource;

  const sockets = new Set<WebSocket>();
  const Socket0 = window.WebSocket;
  host.WebSocket = class extends Socket0 {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.add(this);
    }
  };
  /* A closed stream or socket keeps no listener alive: the page lets go of it. */
  const closed = (t: EventTarget) => (t instanceof FakeEventSource && t.readyState === 2) || (t instanceof Socket0 && t.readyState === Socket0.CLOSED);

  const deliver = (m: unknown) => {
    const data = JSON.stringify(m);
    for (const s of streams) if ((s as FakeEventSource).readyState !== 2) s.dispatchEvent(new MessageEvent('message', { data }));
  };
  host.__hhLive = messages => messages.forEach(deliver);
  /* As the server's stream comes: each message is a task of its own, with whatever the page does between them. */
  host.__hhLiveApart = messages =>
    new Promise<void>(done => {
      const channel = new MessageChannel();
      let i = 0;
      channel.port1.onmessage = () => {
        if (i < messages.length) deliver(messages[i++]);
        if (i < messages.length) channel.port2.postMessage(0);
        else {
          channel.port1.close();
          done();
        }
      };
      channel.port2.postMessage(0);
    });
  /* Which listeners these are: the target and the event, so a leak names its place. */
  const nameOf = (t: EventTarget) => (t === window ? 'window' : t === document ? 'document' : t.constructor.name);
  host.__hhListeners = () => {
    const out: Record<string, number> = {};
    for (const [target, set] of listeners) {
      if (closed(target)) continue;
      for (const key of set) {
        const name = `${nameOf(target)}:${key.split('|')[0]}`;
        out[name] = (out[name] ?? 0) + 1;
      }
    }
    return out;
  };
  host.__hhProbe = () => ({
    commits,
    timeouts: timeouts.size,
    intervals: intervals.size,
    frames: frames.size,
    resizeTargets,
    resizeCallbacks,
    mutationObservers,
    globalListeners: [...listeners.entries()].filter(([t]) => !closed(t)).reduce((n, [, s]) => n + s.size, 0),
    streams: streams.filter(s => (s as FakeEventSource).readyState !== 2).length,
    sockets: [...sockets].filter(s => s.readyState !== Socket0.CLOSED).length,
    nodes: document.getElementsByTagName('*').length,
    xterms: document.querySelectorAll('.xterm').length,
  });
}

export const readProbe = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__hhProbe());

export const readListeners = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__hhListeners());

/* The kinds of listener that grew between two readings. */
export function listenersGrown(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(after)) if (n - (before[name] ?? 0) !== 0) out[name] = n - (before[name] ?? 0);
  return out;
}

/* Sends the messages through the stream all in one task. */
export const sendLive = (page: Page, messages: unknown[]) => page.evaluate(ms => (window as unknown as ProbeWindow).__hhLive(ms), messages);

/* Sends the messages through the stream as the server's burst comes, each in a task of its own. */
export const sendLiveApart = (page: Page, messages: unknown[]) => page.evaluate(ms => (window as unknown as ProbeWindow).__hhLiveApart(ms), messages);

/* Two frames: whatever the last step set going is on the screen. */
export const settled = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/* What grew between two probes; the counters of what happened since load count what happened between them. */
export function growth(before: RenderProbe, after: RenderProbe): RenderProbe {
  const out = {} as RenderProbe;
  for (const key of Object.keys(after) as (keyof RenderProbe)[]) out[key] = after[key] - before[key];
  return out;
}
