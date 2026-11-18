import type { Language } from '../../src/i18n';
import { expect, type Page } from '@playwright/test';
import type { StreamMessage } from '../../src/types';
import { BASE_ISO } from './clock';

declare global {
  interface Window {
    __hhPushStream?: (msg: StreamMessage) => void;
    __hhTriggerPoll?: () => void;
  }
}

/* Installs an in-page EventSource for /api/stream and tracks 5s refresh timers so live listeners, pulses and polling
   screens (Machines, Subscriptions) update cleanly on cue without closing or reconnecting mid-recording. */
export async function installLiveStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const sources: (EventTarget & { readyState: number })[] = [];
    const pollers = new Map<number, () => void>();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);

    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, timeout, ...args);
      if (typeof handler === 'function' && timeout === 5000) {
        pollers.set(id, () => (handler as (...a: unknown[]) => void)(...args));
      }
      return id;
    }) as typeof window.setInterval;

    window.clearInterval = ((id?: number) => {
      if (typeof id === 'number') pollers.delete(id);
      nativeClearInterval(id);
    }) as typeof window.clearInterval;

    class MockStream extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 1;
      onopen: ((ev: Event) => unknown) | null = null;
      onmessage: ((ev: MessageEvent) => unknown) | null = null;
      onerror: ((ev: Event) => unknown) | null = null;
      withCredentials = false;
      constructor(readonly url: string) {
        super();
        sources.push(this);
        queueMicrotask(() => {
          const ev = new Event('open');
          this.onopen?.(ev);
          this.dispatchEvent(ev);
        });
      }
      close() {
        this.readyState = 2;
      }
    }
    function SourceRouter(url: string | URL, init?: EventSourceInit) {
      const target = String(url);
      if (target.includes('/api/stream')) return new MockStream(target);
      return new NativeEventSource(url, init);
    }
    Object.assign(SourceRouter, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    Object.defineProperty(window, 'EventSource', { value: SourceRouter, configurable: true, writable: true });
    window.__hhPushStream = msg => {
      const payload = JSON.stringify(msg);
      for (const s of sources) {
        if (s.readyState === 2) continue;
        const ev = new MessageEvent('message', { data: payload });
        (s as MockStream).onmessage?.(ev);
        s.dispatchEvent(ev);
      }
    };
    window.__hhTriggerPoll = () => {
      for (const fn of pollers.values()) fn();
    };
  });
}

export async function pushStream(page: Page, msg: StreamMessage): Promise<void> {
  await page.evaluate(m => window.__hhPushStream?.(m), msg);
}

export async function triggerPoll(page: Page): Promise<void> {
  await page.evaluate(() => window.__hhTriggerPoll?.());
}

export type ErrorWatcher = {
  errors: string[];
  assertClean: () => void;
};

export function watchSceneErrors(page: Page): ErrorWatcher {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', res => {
    if (res.status() >= 400 && res.url().includes('/api/')) {
      errors.push(`HTTP ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
    }
  });
  return {
    errors,
    assertClean: () => expect(errors).toEqual([]),
  };
}

export async function prepareScenePage(page: Page, nowIso = BASE_ISO, language: Language = 'en', theme?: string): Promise<ErrorWatcher> {
  await page.clock.setSystemTime(new Date(nowIso));
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    if (theme) localStorage.setItem('hh-theme', theme);
    else localStorage.removeItem('hh-theme');
  }, { language, theme });
  await installLiveStream(page);
  return watchSceneErrors(page);
}
