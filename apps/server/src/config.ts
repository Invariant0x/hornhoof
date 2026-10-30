import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Config = {
  databaseUrl?: string;
  secret: Buffer;
  publicUrl: string;
  port: number;
  secureCookies: boolean;
  webDist: string;
  installScript: string;
  /* The built-in node's key, set by compose. Optional: without it there is no built-in node. */
  nodeKey?: string;
  nodePingMs: number;
  streamPingMs: number;
  /* The running build: the product version, its commit, and how many database migrations it carries. */
  version: string;
  commit: string;
  migrations: number;
  /* Where newer builds are published, and how often to look; 0 looks only when someone asks. */
  image: string;
  registryUrl?: string;
  updateCheckMs: number;
};

/* Both src/ and dist/ sit one level below apps/server, so this finds apps/web/dist either way. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DEFAULT_INSTALL_SCRIPT = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const ROOT_PACKAGE = new URL('../../../package.json', import.meta.url);
const MIGRATIONS = new URL('../drizzle', import.meta.url);

const productVersion = (): string => (JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { version: string }).version;
const migrationCount = (): number => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).length;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env.HORNHOOF_SECRET;
  if (!raw) throw new Error('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) throw new Error('HORNHOOF_SECRET must be 32 bytes encoded as base64.');

  const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a number between 1 and 65535.');
  const nodeKey = env.NODE_KEY || undefined;
  if (nodeKey && nodeKey.length < 32) throw new Error('NODE_KEY must be at least 32 characters. Generate one with: openssl rand -base64 32');
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    secret,
    publicUrl,
    port,
    secureCookies: publicUrl.startsWith('https://'),
    webDist: env.WEB_DIST || DEFAULT_WEB_DIST,
    installScript: env.INSTALL_SCRIPT || DEFAULT_INSTALL_SCRIPT,
    nodeKey,
    nodePingMs: env.NODE_PING_MS ? Number(env.NODE_PING_MS) : 20000,
    streamPingMs: env.STREAM_PING_MS ? Number(env.STREAM_PING_MS) : 25000,
    version: env.HORNHOOF_VERSION || productVersion(),
    commit: env.HORNHOOF_COMMIT || 'local',
    migrations: migrationCount(),
    image: env.HORNHOOF_IMAGE || 'ghcr.io/invariant0x/hornhoof',
    registryUrl: env.REGISTRY_URL || undefined,
    updateCheckMs: env.UPDATE_CHECK_MS ? Number(env.UPDATE_CHECK_MS) : 1800000,
  };
}
