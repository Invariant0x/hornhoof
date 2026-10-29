import { fileURLToPath } from 'node:url';

export type Config = {
  databaseUrl?: string;
  secret: Buffer;
  publicUrl: string;
  port: number;
  secureCookies: boolean;
  webDist: string;
};

/* Both src/ and dist/ sit one level below apps/server, so this finds apps/web/dist either way. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env.HORNHOOF_SECRET;
  if (!raw) throw new Error('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) throw new Error('HORNHOOF_SECRET must be 32 bytes encoded as base64.');

  const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    secret,
    publicUrl,
    port: env.PORT ? Number(env.PORT) : 8080,
    secureCookies: publicUrl.startsWith('https://'),
    webDist: env.WEB_DIST || DEFAULT_WEB_DIST,
  };
}
