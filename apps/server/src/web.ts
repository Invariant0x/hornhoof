import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Fallback } from './errors.js';

const LONG_CACHE = 'public, max-age=31536000, immutable';

export const hasWebApp = (dir: string): boolean => existsSync(join(dir, 'index.html'));

/* No other site may show Hornhoof inside its own page, where a person could be tricked into clicking, and browsers take
   every response as the type it is sent with instead of guessing. The built app runs only its own script files, so an
   injected script does not run. Styles may be inline because the terminal adds its own style tags, the bundled fonts
   and the tab icon are data: addresses, and the terminal's live line is a WebSocket to this same server. */
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

export function addSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
}

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
