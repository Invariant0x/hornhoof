import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { PHONE_LEASE_MS, type PhoneBinding, type PhoneGrant } from '@hornhoof/protocol';
import { UsbPeer } from './usb-peer.js';

export const USB_PEER_PORT = 38997;
export const USB_PEER_PATH = '/phone-bridge';

export const sameBridgeKey = (given: string | undefined, key: string): boolean => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(`Bearer ${key}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/* Docker exposes this listener only on the host's loopback (macOS) or a per-node private network (Linux). */
export async function openUsbBridge(key: string) {
  let peer: UsbPeer | null = null;
  let socket: WebSocket | null = null;
  let alive = true;
  const server = new WebSocketServer({ host: '0.0.0.0', port: USB_PEER_PORT, path: USB_PEER_PATH, maxPayload: 12 * 1024 * 1024, perMessageDeflate: false, verifyClient: (info: { req: IncomingMessage }) => sameBridgeKey(info.req.headers.authorization, key) });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  server.on('error', () => {});
  server.on('connection', ws => {
    if (socket) { ws.close(1008); return; }
    socket = ws; alive = true;
    const own = new UsbPeer(message => ws.send(JSON.stringify(message)), () => ws.terminate());
    peer = own;
    ws.on('pong', () => { alive = true; });
    ws.on('message', data => {
      try { own.receive(JSON.parse(data.toString())); }
      catch { own.close(); }
    });
    ws.on('error', () => own.close());
    ws.on('close', () => { own.close(); if (socket === ws) { socket = null; peer = null; } });
  });
  const timer = setInterval(() => {
    if (!socket) return;
    if (!alive) { peer?.close(); return; }
    alive = false; socket.ping();
  }, 15_000);
  timer.unref();
  return {
    driver(grant: PhoneGrant | null) { if (!peer) throw new Error('phone_usb_unavailable'); return peer.driver(grant); },
    async revoke(binding: PhoneBinding, sessionId: string, generation: number) { return peer ? peer.drained({ binding, sessionId, generation, expiresAt: new Date(Date.now() + PHONE_LEASE_MS).toISOString() }) : false; },
    close() { clearInterval(timer); peer?.close(); server.close(); },
  };
}
