import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Fallback } from './errors.js';

const LONG_CACHE = 'public, max-age=31536000, immutable';

export const hasWebApp = (dir: string): boolean => existsSync(join(dir, 'index.html'));

/* The build of the web app this server serves, for a page nobody is signed in on to reload itself once it changes: the
   sha256 of index.html, which anyone gets at / and can hash alike. It changes with every build of the app, as the page
   names its hashed files, and with nothing else. Null with no web app to serve. */
export const pageBuild = (dir: string): string | null =>
  hasWebApp(dir) ? createHash('sha256').update(readFileSync(join(dir, 'index.html'))).digest('base64url') : null;

/* No other site may show Hornhoof inside its own page, where a person could be tricked into clicking, browsers take
   every response as the type it is sent with instead of guessing, and outbound links send no Referer header. The built
   app runs only its own script files, so an injected script does not run. Styles may be inline because the terminal adds
   its own style tags, the bundled fonts and the tab icon are data: addresses, a picture waiting at the message line
   shows from a blob: address, and the terminal's live line is a WebSocket to this same server. */
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
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
