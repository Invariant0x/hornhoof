import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Fallback } from './errors.js';

const LONG_CACHE = 'public, max-age=31536000, immutable';

export const hasWebApp = (dir: string): boolean => existsSync(join(dir, 'index.html'));

/* Serves the built web app. Vite puts hashed files in assets/, so those can be cached for a year. */
export async function serveWebApp(app: FastifyInstance, dir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dir,
    cacheControl: false,
    setHeaders(res, file) {
      res.header('cache-control', file.includes(`${sep}assets${sep}`) ? LONG_CACHE : 'no-cache');
    },
  });
}

/* Paths like /people or /invite/abc belong to the web app, so they get index.html. */
export const webAppRoutes: Fallback = (req: FastifyRequest, reply: FastifyReply) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;
  const path = req.url.split('?')[0]!;
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/assets/') || path.split('/').pop()!.includes('.')) return undefined;
  return reply.header('cache-control', 'no-cache').sendFile('index.html');
};
