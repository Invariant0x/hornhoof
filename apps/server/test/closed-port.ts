import { createServer, type AddressInfo } from 'node:net';

/* A local port that nothing listens on, since it was free a moment ago and its listener has gone. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
