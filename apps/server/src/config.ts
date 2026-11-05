import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeBuild } from '@hornhoof/protocol';
import { z } from 'zod';
import { LETS_ENCRYPT } from './modules/tls/acme.js';

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
  /* Parts of runs that may run at once on one physical computer. */
  runsPerHost: number;
  /* The running build: the product version, its commit, and how many database migrations it carries. */
  version: string;
  commit: string;
  migrations: number;
  /* The node build this server's nodes should be, which CI gives it and the node image of its commit: the last commit
     that changed that image's files. None for a server built without CI, which then tells no node build apart. */
  nodeBuild: string | null;
  /* Where newer builds are published, and how often to look; 0 looks only when someone asks. */
  image: string;
  registryUrl?: string;
  updateCheckMs: number;
  /* The folder the app shares with the updater service. */
  controlDir: string;
  /* Role and skill templates, loaded once at start. */
  templatesDir: string;
  /* The service that hands out public links like acme.hornhoof.org and relays them to this server. */
  relayUrl: string;
  /* The keeper container's host name: only requests from it may say they came in over https. */
  tunnelHost?: string;
  /* Set by compose when a keeper sits in front: the app then takes its mode from the keeper's word. */
  keeper: boolean;
  /* How much all the files on the company's tasks may take together. */
  taskFilesBytes: number;
  /* The ACME directory the link's certificate comes from; null with certificates off. */
  acmeDirectory: string | null;
  /* The computer the server runs on, as a hash of the key a join from it sends; null for a server installed before. */
  hostId: string | null;
  /* This install's id, which install.sh writes once and never changes; null for one installed before. */
  machineId: string | null;
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
const CERTIFICATES_OFF = 'off';

/* The settings read from the environment, checked once at start so a typo stops the server with a clear message
   instead of running with a broken address or a timer that fires every millisecond. */
const Env = z.object({
  PUBLIC_URL: webAddress('PUBLIC_URL must be the address people open Hornhoof at, starting with http:// or https://, like https://hornhoof.example.com.'),
  PORT: wholeNumber(1, 65535, 'PORT must be a number between 1 and 65535.'),
  NODE_PING_MS: milliseconds('NODE_PING_MS', 1, '20000'),
  STREAM_PING_MS: milliseconds('STREAM_PING_MS', 1, '25000'),
  MAX_RUNS_PER_HOST: wholeNumber(1, 1000, 'MAX_RUNS_PER_HOST must be a whole number between 1 and 1000.').default(1),
  UPDATE_CHECK_MS: milliseconds('UPDATE_CHECK_MS', 0, '1800000'),
  REGISTRY_URL: webAddress('REGISTRY_URL must be an http:// or https:// address.'),
  RELAY_URL: webAddress('RELAY_URL must be an http:// or https:// address, like https://hornhoof.org.'),
  TUNNEL_HOST: z.preprocess(unset, z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'TUNNEL_HOST must be the host name of the keeper container, like keeper.').optional()),
  HORNHOOF_KEEPER: z.preprocess(unset, z.literal('on', { error: 'HORNHOOF_KEEPER must be on, or not set.' }).optional()),
  TASK_FILES_MB: wholeNumber(1, 1_000_000, 'TASK_FILES_MB must be a whole number of megabytes, like 2048.'),
  ACME_DIRECTORY: z.preprocess(
    unset,
    z.union([z.literal(CERTIFICATES_OFF), z.url({ protocol: /^https$/, error: 'ACME_DIRECTORY must be off or an https:// ACME directory address.' })]).optional(),
  ),
  HORNHOOF_HOST_ID: z.preprocess(
    unset,
    z.string().regex(/^[0-9a-f]{64}$/, 'HORNHOOF_HOST_ID must be the 64 characters install.sh writes. Remove the line from .env, or run the install command again.').optional(),
  ),
  HORNHOOF_MACHINE_ID: z.preprocess(
    unset,
    z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/, 'HORNHOOF_MACHINE_ID must be the hex install.sh writes. Remove the line from .env, or run the install command again.').optional(),
  ),
});

/* CI sets it, so one that is not a commit counts as none rather than stopping the server. */
const nodeBuildOf = (env: NodeJS.ProcessEnv): string | null => NodeBuild.safeParse(env.HORNHOOF_NODE_BUILD).data ?? null;
const acmeDirectoryOf = (set: string | undefined): string | null => (set === CERTIFICATES_OFF ? null : (set ?? LETS_ENCRYPT));
const productVersion = (): string => (JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { version: string }).version;
const migrationCount = (): number => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).length;

function secretOf(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.HORNHOOF_SECRET;
  if (!raw) throw new Error('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
  const secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) throw new Error('HORNHOOF_SECRET must be 32 bytes encoded as base64.');
  return secret;
}

function nodeKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  const nodeKey = env.NODE_KEY || undefined;
  if (nodeKey && nodeKey.length < 32) throw new Error('NODE_KEY must be at least 32 characters. Generate one with: openssl rand -base64 32');
  return nodeKey;
}

function checkedEnv(env: NodeJS.ProcessEnv): z.infer<typeof Env> {
  const checked = Env.safeParse(env);
  if (!checked.success) throw new Error(checked.error.issues.map(issue => issue.message).join('\n'));
  return checked.data;
}

/* The running build and where its published images come from. */
function buildOf(env: NodeJS.ProcessEnv, set: z.infer<typeof Env>): Pick<Config, 'version' | 'commit' | 'migrations' | 'nodeBuild' | 'image' | 'registryUrl' | 'updateCheckMs'> {
  return {
    version: env.HORNHOOF_VERSION || productVersion(),
    commit: env.HORNHOOF_COMMIT || 'local',
    migrations: migrationCount(),
    nodeBuild: nodeBuildOf(env),
    image: env.HORNHOOF_IMAGE || 'ghcr.io/invariant0x/hornhoof',
    registryUrl: set.REGISTRY_URL,
    updateCheckMs: set.UPDATE_CHECK_MS ?? 1800000,
  };
}

/* Folders and scripts, each with the place the image keeps it. */
function placesOf(env: NodeJS.ProcessEnv): Pick<Config, 'webDist' | 'installScript' | 'controlDir' | 'templatesDir'> {
  return {
    webDist: env.WEB_DIST || DEFAULT_WEB_DIST,
    installScript: env.INSTALL_SCRIPT || DEFAULT_INSTALL_SCRIPT,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    templatesDir: env.TEMPLATES_DIR || DEFAULT_TEMPLATES,
  };
}

/* Intervals and limits, with their defaults. */
function limitsOf(set: z.infer<typeof Env>): Pick<Config, 'port' | 'nodePingMs' | 'streamPingMs' | 'runsPerHost' | 'taskFilesBytes'> {
  return {
    port: set.PORT ?? 8080,
    nodePingMs: set.NODE_PING_MS ?? 20000,
    streamPingMs: set.STREAM_PING_MS ?? 25000,
    runsPerHost: set.MAX_RUNS_PER_HOST,
    taskFilesBytes: (set.TASK_FILES_MB ?? 2048) * 1024 * 1024,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const secret = secretOf(env);
  const set = checkedEnv(env);
  const publicUrl = (set.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  return {
    ...buildOf(env, set),
    ...placesOf(env),
    ...limitsOf(set),
    databaseUrl: env.DATABASE_URL || undefined,
    secret,
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    nodeKey: nodeKeyOf(env),
    relayUrl: (set.RELAY_URL ?? 'https://hornhoof.org').replace(/\/+$/, ''),
    tunnelHost: set.TUNNEL_HOST,
    keeper: set.HORNHOOF_KEEPER === 'on',
    acmeDirectory: acmeDirectoryOf(set.ACME_DIRECTORY),
    hostId: set.HORNHOOF_HOST_ID ?? null,
    machineId: set.HORNHOOF_MACHINE_ID ?? null,
  };
}
