import { useEffect, useLayoutEffect, useRef } from 'react';
import type { StreamMessage } from './types';

export type LiveMessage = StreamMessage | { type: 'reconnected' };
type Listener = (m: LiveMessage) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let broken = false;
/* A stream the browser gave up on opens again after this wait, which doubles up to the cap while it keeps failing. */
const RETRY_MS = 1000, RETRY_MAX_MS = 30000;
let retry: ReturnType<typeof setTimeout> | null = null;
let wait = RETRY_MS;

const tell = (m: LiveMessage) => {
  for (const fn of [...listeners]) fn(m);
};

/* One stream per tab. After a break the browser reconnects by itself, or Hornhoof opens a new stream when the browser gave up;
   listeners hear "reconnected" and fetch what they missed. */
function connect(): void {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/stream');
  source = es;
  es.addEventListener('message', e => {
    let m: StreamMessage;
    try {
      m = JSON.parse((e as MessageEvent<string>).data);
    } catch {
      return;
    }
    tell(m);
  });
  es.addEventListener('error', () => {
    broken = true;
    /* An error page, such as a proxy's while Hornhoof restarts, closes the stream for good. */
    if (es.readyState !== EventSource.CLOSED || source !== es || retry) return;
    es.close();
    retry = setTimeout(() => {
      retry = null;
      if (listeners.size) connect();
    }, wait);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  });
  es.addEventListener('open', () => {
    wait = RETRY_MS;
    if (!broken) return;
    broken = false;
    tell({ type: 'reconnected' });
  });
}

/* Calls fn for everything the server says live until the returned function is called. */
export function listen(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size || !source) return;
    source.close();
    source = null;
    broken = false;
    if (retry) clearTimeout(retry);
    retry = null;
    wait = RETRY_MS;
  };
}

/* Calls onMessage for everything the server says live, for as long as the component is on screen. */
export function useStream(onMessage: Listener): void {
  const latest = useRef(onMessage);
  /* At commit, not after paint: a message that comes right after a render must reach that render's handler. */
  useLayoutEffect(() => {
    latest.current = onMessage;
  });
  useEffect(() => listen(m => latest.current(m)), []);
}
