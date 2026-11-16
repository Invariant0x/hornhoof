import { WebSocket } from 'ws';
import type { PhoneBridgeAuthorization } from '@hornhoof/protocol';
import type { NodeState } from '../state.js';
import { PhoneAdb, privateAdb } from './adb.js';
import { UsbHost } from './usb-host.js';

export type UsbHostConfig = { state: NodeState; socket: string; server: string; adb: string; keyDir: string };

export function localBridgeSocket(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === 'ws:' && !u.username && !u.password && u.pathname === '/phone-bridge' && !u.search && !u.hash && Boolean(u.port) && (u.hostname === '127.0.0.1' || /^hornhoof-[A-Za-z0-9_-]+$/.test(u.hostname));
  } catch { return false; }
}

export async function authorizeBridge(server: string, key: string, input: PhoneBridgeAuthorization, signal: AbortSignal, request: typeof fetch = fetch): Promise<boolean> {
  const stop = new AbortController();
  const abort = () => stop.abort();
  if (signal.aborted) stop.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await request(new URL('/api/nodes/phone-bridge/authorize', server), { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: stop.signal });
    if (response.status !== 200) return false;
    const result: unknown = await response.json();
    return typeof result === 'object' && result !== null && 'allowed' in result && result.allowed === true;
  } catch { return false; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

/* The helper opens an outgoing authenticated link. It opens no host listener and has no general shell API. */
export function startUsbHost(config: UsbHostConfig): { stop(): void } {
  if (!localBridgeSocket(config.socket)) throw new Error('phone_bridge_config_invalid');
  const server = new URL(config.server);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password) throw new Error('phone_bridge_config_invalid');
  let stopped = false;
  let socket: WebSocket | null = null;
  let host: UsbHost | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const adb = new PhoneAdb(privateAdb(config.adb, config.keyDir));
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(config.socket, { headers: { authorization: `Bearer ${config.state.key}` }, perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 10_000 });
    socket = ws;
    const own = new UsbHost({ adb, authorize: (input, signal) => authorizeBridge(config.server, config.state.key, input, signal), send: message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); } });
    host = own;
    ws.on('message', data => {
      try { void own.receive(JSON.parse(data.toString())); }
      catch { ws.terminate(); }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      own.close();
      void own.drained().then(() => { if (!stopped) retry = setTimeout(connect, 1000); });
    });
  };
  connect();
  return { stop() { stopped = true; if (retry) clearTimeout(retry); host?.close(); socket?.terminate(); } };
}
