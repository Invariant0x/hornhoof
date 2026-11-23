import { useEffect, useLayoutEffect, useRef } from 'react';
import { connection } from './connection';
import { rateMeter } from './guard';
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

/* A company of 120 agents says dozens of things a second, each message a task of its own and a drawing of every screen
   that hears it. Past STORM_LIMIT messages a second the stream hands them on together every FLUSH_MS, so each screen
   draws once for all of them. More than QUEUE_MAX waiting is more than a screen should catch up on one by one: they
   become one "reconnected", and every screen fetches what it shows anew. */
const STORM_LIMIT = 30, STORM_WINDOW_MS = 1000, FLUSH_MS = 50, QUEUE_MAX = 1000;
let storm = rateMeter(STORM_LIMIT, STORM_WINDOW_MS);
let queue: LiveMessage[] = [];
let flushing: ReturnType<typeof setTimeout> | null = null;

const deliver = (m: LiveMessage) => {
  for (const fn of [...listeners]) fn(m);
};

function flush(): void {
  flushing = null;
  const batch = queue;
  queue = [];
  batch.forEach(deliver);
}

const tell = (m: LiveMessage) => {
  if (!storm.hit() && !flushing) return deliver(m);
  if (queue.length >= QUEUE_MAX) queue = [{ type: 'reconnected' }];
  queue.push(m);
  flushing ??= setTimeout(flush, FLUSH_MS);
};

/* No one listens any more: nothing waits to be handed on, and the next listener starts with no storm behind it. */
function calm(): void {
  if (flushing) clearTimeout(flushing);
  flushing = null;
  queue = [];
  storm = rateMeter(STORM_LIMIT, STORM_WINDOW_MS);
}

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
    /* A stream that breaks while the server answers is nothing to tell: the page looks, and says so only if it is away. */
    connection.lost();
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

/* The server answers again after it was away: a stream that gave up opens at once, not when its own wait is over. */
function reopen(): void {
  if (!listeners.size || !source || source.readyState !== EventSource.CLOSED) return;
  if (retry) clearTimeout(retry);
  retry = null;
  wait = RETRY_MS;
  source = null;
  connect();
}

/* The server answers again after an update held it. What the screens asked for meanwhile was refused, so every listener
   hears "reconnected" and fetches what it shows anew, as after a break of the stream. */
export function heardAgain(): void {
  tell({ type: 'reconnected' });
}

/* When the server answers again after the layer over the page showed, every screen fetches what it shows anew and the
   stream opens again. */
connection.onBack(() => {
  reopen();
  heardAgain();
});

/* A newer answer can arrive before an earlier request completes. Only answers still in order count. */
export function latestAnswers(): () => () => boolean {
  let asked = 0;
  let shown = 0;
  return () => {
    const n = ++asked;
    return () => {
      if (n < shown) return false;
      shown = n;
      return true;
    };
  };
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
    calm();
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
