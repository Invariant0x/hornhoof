import { ACKS_HEADER, parseServerMessage, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import WebSocket from 'ws';

type Backoff = {
  firstMs: number;
  /* The longest pause between tries; a node on a machine that stays away for long still comes back soon after the app. */
  maxMs: number;
  /* The pause after the server refused the key. */
  refusedMs: number;
  /* How long a handshake that gets no answer may take. */
  handshakeMs: number;
};

type Options = {
  url: string;
  key: string;
  log?(line: string): void;
  /* acks: the server says in its upgrade answer that it confirms numbered messages. */
  onOpen(send: (m: NodeMessage) => boolean, acks: boolean): void;
  onMessage(m: ServerMessage): void;
  /* Hornhoof does not know this key any more: the machine was disconnected there. */
  onRefused?(): void;
  backoff?: Partial<Backoff>;
};

const DEFAULT_BACKOFF: Backoff = { firstMs: 1000, maxMs: 10_000, refusedMs: 60_000, handshakeMs: 20_000 };

const note = (opts: Options, text: string): void => opts.log?.(text);

/* Keeps one socket to Hornhoof open, reconnecting with growing pauses. send() returns false while offline. */
export function connect(opts: Options): { close(): void } {
  const { firstMs, maxMs, refusedMs, handshakeMs } = { ...DEFAULT_BACKOFF, ...opts.backoff };
  let delay = firstMs;
  let stopped = false;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | undefined;

  const retry = () => {
    if (stopped) return;
    timer = setTimeout(open, delay);
    delay = Math.min(delay * 2, maxMs);
  };

  function open() {
    const ws = new WebSocket(opts.url, { headers: { authorization: `Bearer ${opts.key}` }, handshakeTimeout: handshakeMs });
    socket = ws;
    let acks = false;
    ws.on('upgrade', res => {
      acks = res.headers[ACKS_HEADER] === '1';
    });
    ws.on('open', () => {
      note(opts, 'Connected to Hornhoof.');
      delay = firstMs;
      opts.onOpen(m => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(m));
        return true;
      }, acks);
    });
    ws.on('message', data => {
      const msg = parseServerMessage(String(data));
      if (msg) opts.onMessage(msg);
    });
    ws.on('error', err => {
      note(opts, `Connection error: ${err.message}`);
      if (/\b401\b/.test(err.message)) {
        delay = refusedMs;
        opts.onRefused?.();
      }
    });
    ws.on('close', code => {
      note(opts, `Connection closed with code ${code}.`);
      if (code === 4001) {
        delay = refusedMs;
        opts.onRefused?.();
      }
      retry();
    });
  }

  open();
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
