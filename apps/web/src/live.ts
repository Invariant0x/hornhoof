import { useEffect, useRef } from 'react';
import type { StreamMessage } from './types';

export type LiveMessage = StreamMessage | { type: 'reconnected' };
type Listener = (m: LiveMessage) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let broken = false;

const tell = (m: LiveMessage) => {
  for (const fn of [...listeners]) fn(m);
};

/* One stream per tab. After a break the browser reconnects by itself; listeners hear "reconnected" and fetch what they missed. */
function connect(): void {
  if (typeof EventSource === 'undefined') return;
  source = new EventSource('/api/stream');
  source.addEventListener('message', e => {
    let m: StreamMessage;
    try {
      m = JSON.parse((e as MessageEvent<string>).data);
    } catch {
      return;
    }
    tell(m);
  });
  source.addEventListener('error', () => {
    broken = true;
  });
  source.addEventListener('open', () => {
    if (!broken) return;
    broken = false;
    tell({ type: 'reconnected' });
  });
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size || !source) return;
    source.close();
    source = null;
    broken = false;
  };
}

/* Calls onMessage for everything the server says live, for as long as the component is on screen. */
export function useStream(onMessage: Listener): void {
  const latest = useRef(onMessage);
  useEffect(() => {
    latest.current = onMessage;
  });
  useEffect(() => subscribe(m => latest.current(m)), []);
}
