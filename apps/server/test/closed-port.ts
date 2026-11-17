import { createServer, type AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';

/* Hold the unavailable address for the whole test, so another process cannot turn it into a live service. */
export async function closedPort(): Promise<number> {
  const server = createServer(socket => { socket.on('error', () => undefined); socket.resetAndDestroy(); });
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  await listenIn(server);
  const { port } = server.address() as AddressInfo;
  return port;
}
