import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeBuild } from '@hornhoof/protocol';
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
  nodeDrainMs: number;
  nodeUpdateRetryMs: number;
  nodeLeaderHoldMs: number;
  /* The folder the app shares with the updater service. */
  controlDir: string;
  /* Role and skill templates, loaded once at start. */
  templatesDir: string;
  /* The service that hands out public links like acme.hornhoof.org and relays them to this server. */
  relayUrl: string;
  /* Where the Telegram Bot API answers; tests put a stand-in here. */
  telegramApiUrl: string;
  /* The tunnel container's host name: only requests from it may say they came in over https. */
  tunnelHost?: string;
  /* How much all the files on the company's tasks may take together. */
  taskFilesBytes: number;
  /* Where the bundles of products' test harnesses lie, and how much they may take. No folder: each machine builds its own. */
  harnessDir?: string;
  harnessBytes: number;
  /* The computer the server runs on, as a hash of the key a join from it sends; null for a server installed before. */
  hostId: string | null;
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
  MAX_RUNS_PER_HOST: wholeNumber(1, 1000, 'MAX_RUNS_PER_HOST must be a whole number between 1 and 1000.').default(1),
  UPDATE_CHECK_MS: milliseconds('UPDATE_CHECK_MS', 0, '1800000'),
  /* Just under the 99th percentile of the turns that ended well, 5438 s in a week of them on 2026-11-04, and a turn has
     run for a while when the wait starts; a held node works again after that. */
  NODE_DRAIN_MS: milliseconds('NODE_DRAIN_MS', 1, '5400000').default(5_400_000),
  /* Long enough for 90% of the turns that waited for the node to run and end before it holds them again. */
  NODE_UPDATE_RETRY_MS: milliseconds('NODE_UPDATE_RETRY_MS', 1, '900000').default(900_000),
  /* How long a node that waits for an update keeps new turns of the orchestrator and the heads off it. Replacing a free
     node takes under a minute, so past this the node has work that runs on. */
  NODE_LEADER_HOLD_MS: milliseconds('NODE_LEADER_HOLD_MS', 1, '180000').default(180_000),
  REGISTRY_URL: webAddress('REGISTRY_URL must be an http:// or https:// address.'),
  RELAY_URL: webAddress('RELAY_URL must be an http:// or https:// address, like https://hornhoof.org.'),
  TELEGRAM_API_URL: webAddress('TELEGRAM_API_URL must be an http:// or https:// address, like https://api.telegram.org.'),
  TUNNEL_HOST: z.preprocess(unset, z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'TUNNEL_HOST must be the host name of the tunnel container, like tunnel.').optional()),
  TASK_FILES_MB: wholeNumber(1, 1_000_000, 'TASK_FILES_MB must be a whole number of megabytes, like 2048.'),
  HARNESS_DIR: z.preprocess(unset, z.string().min(1).optional()),
  HARNESS_MB: wholeNumber(1, 100_000_000, 'HARNESS_MB must be a whole number of megabytes, like 20480.'),
  HORNHOOF_HOST_ID: z.preprocess(
    unset,
    z.string().regex(/^[0-9a-f]{64}$/, 'HORNHOOF_HOST_ID must be the 64 characters install.sh writes. Remove the line from .env, or run the install command again.').optional(),
  ),
});

/* CI sets it, so one that is not a commit counts as none rather than stopping the server. */
const nodeBuildOf = (env: NodeJS.ProcessEnv): string | null => NodeBuild.safeParse(env.HORNHOOF_NODE_BUILD).data ?? null;
const productVersion = (): string => (JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { version: string }).version;
const migrationCount = (): number => readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).length;

const harnessSettings = (set: z.infer<typeof Env>): Pick<Config, 'harnessDir' | 'harnessBytes'> => ({ ...(set.HARNESS_DIR ? { harnessDir: set.HARNESS_DIR } : {}), harnessBytes: (set.HARNESS_MB ?? 20_480) * 1024 * 1024 });

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
    runsPerHost: set.MAX_RUNS_PER_HOST,
    version: env.HORNHOOF_VERSION || productVersion(),
    commit: env.HORNHOOF_COMMIT || 'local',
    migrations: migrationCount(),
    nodeBuild: nodeBuildOf(env),
    image: env.HORNHOOF_IMAGE || 'ghcr.io/invariant0x/hornhoof',
    registryUrl: set.REGISTRY_URL,
    updateCheckMs: set.UPDATE_CHECK_MS ?? 1800000,
    nodeDrainMs: set.NODE_DRAIN_MS,
    nodeUpdateRetryMs: set.NODE_UPDATE_RETRY_MS,
    nodeLeaderHoldMs: set.NODE_LEADER_HOLD_MS,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    templatesDir: env.TEMPLATES_DIR || DEFAULT_TEMPLATES,
    relayUrl: (set.RELAY_URL ?? 'https://hornhoof.org').replace(/\/+$/, ''),
    telegramApiUrl: (set.TELEGRAM_API_URL ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    tunnelHost: set.TUNNEL_HOST,
    taskFilesBytes: (set.TASK_FILES_MB ?? 2048) * 1024 * 1024,
    ...harnessSettings(set),
    hostId: set.HORNHOOF_HOST_ID ?? null,
  };
}
