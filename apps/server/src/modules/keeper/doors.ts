import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAddressOf } from '../../auth/tunnel.js';
import { DB_DOOR_PORT } from '../../net/db-door.js';
import { firstForwarded, INVOCATION, socketAddress, UUID, updatingAnswer, type Refusal } from '../../net/proxy.js';

/* What every keeper's doors share, the keeper of a machine that keeps data and a worker's alike. */

/* peerApp: what the relay's service for the app alone reaches, on this machine only. db: the door through which the
   database of a machine that keeps a copy reaches the leader's. */
export const KEEPER_PORTS = { peer: 7070, peerApp: 7071, front: 7080, linkHttp: 7081, db: DB_DOOR_PORT } as const;

const MAINTENANCE_JSON = JSON.stringify({
  error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' },
});

export function maintenanceAnswer(req: http.IncomingMessage): Refusal {
  return updatingAnswer(req, MAINTENANCE_JSON);
}

/* The id front stamped a tool call with, when the request has one. */
function invocationOf(req: http.IncomingMessage): Record<string, string> {
  const id = String(req.headers[INVOCATION] ?? '').toLowerCase();
  return UUID.test(id) ? { [INVOCATION]: id } : {};
}

/* Anyone on the default network can reach the front port and write a header, so what it says counts only from front:
   the visitor's address, and the id of a tool call. */
export const visitorFromFront =
  (frontHost: string | null) =>
  async (req: http.IncomingMessage): Promise<Record<string, string>> => {
    if (!(await isAddressOf(frontHost, socketAddress(req)))) return { 'x-forwarded-for': socketAddress(req) };
    return { 'x-forwarded-for': firstForwarded(req) || socketAddress(req), ...invocationOf(req) };
  };

export function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    /* It stays on: after the start an error is one failed accept, and the next visitor should still get through. */
    server.on('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

export function closeWithin(server: http.Server, ms: number): Promise<void> {
  return new Promise(resolve => {
    const giveUp = setTimeout(resolve, ms);
    server.close(() => {
      clearTimeout(giveUp);
      resolve();
    });
  });
}
