import { join } from 'node:path';
import { clientFor } from './modules/link/client.js';
import { TunnelKeeper } from './modules/link/tunnel.js';

/* The tunnel container: it carries the company's public link at hornhoof.org to the app, with the settings the app
   writes into the control folder, and waits while there are none. */
const keeper = new TunnelKeeper({
  file: join(process.env.HORNHOOF_CONTROL_DIR || '/control', 'tunnel.json'),
  everyMs: 3000,
  restartMs: 2000,
  clientFor,
  log: line => console.log(line),
});
keeper.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void keeper.stop().then(() => process.exit(0));
  });
}
