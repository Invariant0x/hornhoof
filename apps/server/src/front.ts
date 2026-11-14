import { startFront } from './net/front.js';

/* Docker waits 10 s after its stop signal. A request in flight gets half of that to finish; an open socket, which never
   ends by itself, does not hold the stop up for longer. */
const STOP_GRACE_MS = 5000;

const server = await startFront({ port: 8080, keeper: { host: 'keeper', port: 7080 } });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const exit = () => process.exit(0);
    server.close(exit);
    setTimeout(exit, STOP_GRACE_MS);
  });
}
