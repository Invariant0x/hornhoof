import { createServer } from 'node:net';

/* Tests open ports only in one narrow corridor, below the range the system gives out for outgoing connections, so a test never
   meets a port the machine chose at random. Each test worker has its own share of the corridor, and a port in use is passed over. */
export const CORRIDOR = Object.freeze({ first: 24000, size: 1000, shares: 16 });
const SHARE = Math.floor(CORRIDOR.size / CORRIDOR.shares);
/* How far into its share the process has gone: each server starts past the port the last one took. */
let turn = 0;

/* The share of a worker: vitest numbers its workers from 1; a process outside vitest takes the share of its pid. */
export function corridorShare(env = process.env, pid = process.pid) {
  const id = Number(env.VITEST_POOL_ID ?? env.VITEST_WORKER_ID);
  const index = Number.isInteger(id) && id > 0 ? (id - 1) % CORRIDOR.shares : pid % CORRIDOR.shares;
  const first = CORRIDOR.first + index * SHARE;
  return { first, last: first + SHARE - 1 };
}

function nextPorts(start) {
  const { first } = corridorShare();
  return Array.from({ length: SHARE }, (_, i) => first + ((start + i) % SHARE));
}

const listening = (server, port, host) => new Promise((resolve, reject) => {
  const failed = error => { server.off('listening', done); reject(error); };
  const done = () => { server.off('error', failed); resolve(); };
  server.once('error', failed).once('listening', done);
  server.listen(port, host);
});

/* Starts a net or http server on the next free port of this worker's share and returns that port. The next server starts
   past it, even where ports before it were taken: a process that opened again a port it has just closed would have its
   client take a connection it keeps to the closed server, which the server ended, for one to the new server. */
export async function listenIn(server, host = '127.0.0.1') {
  const start = turn++;
  for (const [i, port] of nextPorts(start).entries()) {
    try {
      await listening(server, port, host);
      turn = Math.max(turn, start + i + 1);
      return port;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  const { first, last } = corridorShare();
  throw new Error(`No free port in ${first}-${last}.`);
}

/* A free port of this worker's share, for a server that takes its port when it is made. */
export async function testPort(host = '127.0.0.1') {
  const probe = createServer();
  const port = await listenIn(probe, host);
  await new Promise(resolve => { probe.close(resolve); });
  return port;
}

/* Starts a server that takes its port as it starts, like a Fastify app, on a free port of this worker's share, and
   returns what its start returns. A port taken meanwhile is passed over. */
export async function listenAt(start, host = '127.0.0.1') {
  for (let tries = 0; tries < SHARE; tries++) {
    const port = await testPort(host);
    try {
      return await start(port);
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  const { first, last } = corridorShare();
  throw new Error(`No free port in ${first}-${last}.`);
}
