import type http from 'node:http';
import { passThrough, serve, socketAddress, startingAnswer, type Target } from './proxy.js';

/* The company's web port. Whatever a visitor says about itself stops here: the keeper hears the socket's address. */
export function startFront(opts: { port: number; host?: string; keeper: Target }): Promise<http.Server> {
  const server = serve(
    passThrough({
      target: opts.keeper,
      headers: req => ({ 'x-forwarded-for': socketAddress(req) }),
      unreachable: startingAnswer,
    }),
  );
  return new Promise((resolve, reject) => {
    /* It stays on: after the start an error is one failed accept, and the next visitor should still get through. */
    server.on('error', reject);
    server.listen(opts.port, opts.host || '0.0.0.0', () => resolve(server));
  });
}
