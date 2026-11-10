import http from 'node:http';
import { frontCalls } from './front-calls.js';
import { HOLD_MS, passThrough, serve, socketAddress, startingAnswer, type Target } from './proxy.js';

/* The company's web port. Whatever a visitor says about itself stops here: the keeper hears the socket's address. A
   request that comes while the keeper restarts is held for it, and an agent's tool call is stamped and sent again until
   it is answered, so neither a page nor an agent sees a restart. holdMs 0 holds nothing. */
export function startFront(opts: { port: number; host?: string; keeper: Target; holdMs?: number; callHoldMs?: number }): Promise<http.Server> {
  const calls = frontCalls({ keeper: opts.keeper, holdMs: opts.callHoldMs });
  const rest = passThrough({
    target: opts.keeper,
    headers: req => ({ 'x-forwarded-for': socketAddress(req) }),
    unreachable: startingAnswer,
    holdMs: opts.holdMs ?? HOLD_MS,
  });
  const server = serve({ request: (req, res) => void (calls(req, res) || rest.request(req, res)), upgrade: rest.upgrade });
  return new Promise((resolve, reject) => {
    /* It stays on: after the start an error is one failed accept, and the next visitor should still get through. */
    server.on('error', reject);
    server.listen(opts.port, opts.host || '0.0.0.0', () => resolve(server));
  });
}
