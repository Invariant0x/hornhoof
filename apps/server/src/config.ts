import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
  /* The folder the app shares with the updater service. */
  controlDir: string;
  /* Role and skill templates, loaded once at start. */
  templatesDir: string;
};

/* Both src/ and dist/ sit one level below apps/server, so this finds apps/web/dist either way. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DEFAULT_INSTALL_SCRIPT = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const ROOT_PACKAGE = new URL('../../../package.json', import.meta.url);
const DEFAULT_TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const MIGRATIONS = new URL('../drizzle', import.meta.url);

/* Compose hands over a variable it was given empty, so empty means not set. */
const unset = (value: unknown) => (value === '' ? undefined : value);
/* Node runs a timer whose wait is not a number, or longer than this, every millisecond. */
const MAX_TIMER_MS = 2_147_483_647;
const wholeNumber = (min: number, max: number, message: string) =>
  z.preprocess(unset, z.string().regex(/^\d+$/, message).transform(Number).refine(n => n >= min && n <= max, message).optional());
const milliseconds = (name: string, min: number, example: string) =>
  wholeNumber(min, MAX_TIMER_MS, `${name} must be a whole number of milliseconds${min === 0 ? ', or 0' : ''}, like ${example}.`);
const webAddress = (message: string) => z.preprocess(unset, z.url({ protocol: /^https?$/, error: message }).optional());

/* The settings read from the environment, checked once at start so a typo stops the server with a clear message
   instead of running with a broken address or a timer that fires every millisecond. */
const Env = z.object({
  PUBLIC_URL: webAddress('PUBLIC_URL must be the address people open Hornhoof at, starting with http:// or https://, like https://hornhoof.example.com.'),
  PORT: wholeNumber(1, 65535, 'PORT must be a number between 1 and 65535.'),
  NODE_PING_MS: milliseconds('NODE_PING_MS', 1, '20000'),
  STREAM_PING_MS: milliseconds('STREAM_PING_MS', 1, '25000'),
  UPDATE_CHECK_MS: milliseconds('UPDATE_CHECK_MS', 0, '1800000'),
  REGISTRY_URL: webAddress('REGISTRY_URL must be an http:// or https:// address.'),
});

const productVersion = (): string => (JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { version: string }).version;
const migrationCount = (): number => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).length;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = env.HORNHOOF_SECRET;
  if (!raw) throw new Error('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) throw new Error('HORNHOOF_SECRET must be 32 bytes encoded as base64.');

  const checked = Env.safeParse(env);
  if (!checked.success) throw new Error(checked.error.issues.map(issue => issue.message).join('\n'));
  const set = checked.data;
  const publicUrl = (set.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const nodeKey = env.NODE_KEY || undefined;
  if (nodeKey && nodeKey.length < 32) throw new Error('NODE_KEY must be at least 32 characters. Generate one with: openssl rand -base64 32');
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    secret,
    publicUrl,
    port: set.PORT ?? 8080,
    secureCookies: publicUrl.startsWith('https://'),
    webDist: env.WEB_DIST || DEFAULT_WEB_DIST,
    installScript: env.INSTALL_SCRIPT || DEFAULT_INSTALL_SCRIPT,
    nodeKey,
    nodePingMs: set.NODE_PING_MS ?? 20000,
    streamPingMs: set.STREAM_PING_MS ?? 25000,
    version: env.HORNHOOF_VERSION || productVersion(),
    commit: env.HORNHOOF_COMMIT || 'local',
    migrations: migrationCount(),
    image: env.HORNHOOF_IMAGE || 'ghcr.io/invariant0x/hornhoof',
    registryUrl: set.REGISTRY_URL,
    updateCheckMs: set.UPDATE_CHECK_MS ?? 1800000,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    templatesDir: env.TEMPLATES_DIR || DEFAULT_TEMPLATES,
  };
}
