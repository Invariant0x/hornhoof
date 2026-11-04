import { parseServerMessage } from '@hornhoof/protocol';
import { OperatorDeliveryMetadata, OperatorServerMessage, type ProgramNodeMessage, type ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import WebSocket from 'ws';

export function parseOperatorServerMessage(raw: string): ProgramServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    const operator = OperatorServerMessage.safeParse(value);
    if (operator.success) return operator.data;
    const base = parseServerMessage(raw);
    if (base?.type !== 'job.run' && base?.type !== 'agent.say') return base;
    const metadata = OperatorDeliveryMetadata.safeParse(value);
    return metadata.success ? { ...base, ...metadata.data } : null;
  } catch { return null; }
}

type Options = {
  url: string;
  key: string;
  log?(line: string): void;
  onOpen(send: (m: ProgramNodeMessage) => boolean): void;
  onMessage(m: ProgramServerMessage): void;
  onClose?(): void;
  /* Hornhoof does not know this key any more: the machine was disconnected there. */
  onRefused?(): void;
  backoff?: { firstMs: number; maxMs: number };
};

const note = (opts: Options, text: string): void => opts.log?.(text);

/* Keeps one socket to Hornhoof open, reconnecting with growing pauses. send() returns false while offline. */
export function connect(opts: Options): { close(): void } {
  const { firstMs, maxMs } = opts.backoff ?? { firstMs: 1000, maxMs: 60_000 };
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
    const ws = new WebSocket(opts.url, { headers: { authorization: `Bearer ${opts.key}` } });
    socket = ws;
    ws.on('open', () => {
      note(opts, 'Connected to Hornhoof.');
      delay = firstMs;
      opts.onOpen(m => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(m));
        return true;
      });
    });
    ws.on('message', data => {
      const msg = parseOperatorServerMessage(String(data));
      if (msg) opts.onMessage(msg);
    });
    ws.on('error', err => {
      note(opts, `Connection error: ${err.message}`);
      if (/\b401\b/.test(err.message)) {
        delay = maxMs;
        opts.onRefused?.();
      }
    });
    ws.on('close', code => {
      opts.onClose?.();
      note(opts, `Connection closed with code ${code}.`);
      if (code === 4001) {
        delay = maxMs;
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
