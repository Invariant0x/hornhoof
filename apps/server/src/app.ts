import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';

export type { Db } from './db/client.js';
import type { Db } from './db/client.js';

export type Deps = { db: Db; config: Config };

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandling(app);
  app.get('/api/health', async () => ({ ok: true }));
  void deps;
  return app;
}
