import { act } from '@testing-library/react';
import { vi } from 'vitest';

type Handler = (e: { data?: string }) => void;

/* A stand-in for the browser's EventSource that tests drive by hand. */
export class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  private handlers = new Map<string, Set<Handler>>();

  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }

  addEventListener(type: string, fn: Handler): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  fire(type: string, data?: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) });
  }
}

/* Stubs EventSource for this test and returns a way to send a message to every open stream. */
export function fakeStream() {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  return {
    sources: () => FakeEventSource.all,
    send: (m: unknown) => act(() => FakeEventSource.all.filter(s => !s.closed).forEach(s => s.fire('message', m))),
  };
}
