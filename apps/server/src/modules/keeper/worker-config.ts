import { publishedFrom, type Published } from './identity.js';
import { KEEPER_DIR } from './machine-keys.js';

/* What a worker's keeper is started with. It holds no secret of the company: neither the server's secret, nor the node
   key, nor a way to the database. */
export type WorkerConfig = {
  /* This keeper's id in the network: the id install.sh gave the computer. */
  machineId: string;
  /* The address the join command came from. */
  joinServer: string;
  ticket: string | null;
  controlDir: string;
  dir: string;
  commit: string;
  ports: Published;
  /* The machine's addresses as the installer wrote them down. */
  addresses: string[];
  hostname: string | null;
  /* The key of the machine's owner, as the command they ran here carried it. */
  ownerKey: string | null;
};

const MACHINE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const OWNER_KEY = /^[A-Za-z0-9_-]{80,200}$/;
const RUN_AGAIN = 'Run the join command from Hornhoof on this machine again.';

function joinServerOf(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    /* Said below. */
  }
  throw new Error(`HORNHOOF_JOIN_SERVER is not the address of the company's server. ${RUN_AGAIN}`);
}

/* Reads the worker's own lines of the environment and nothing else of it. */
export function workerConfig(env: NodeJS.ProcessEnv, log: (line: string) => void = () => undefined): WorkerConfig {
  const machineId = env.HORNHOOF_MACHINE_ID ?? '';
  if (!MACHINE_ID.test(machineId)) throw new Error(`HORNHOOF_MACHINE_ID is not set. ${RUN_AGAIN}`);
  const ownerKey = env.HORNHOOF_OWNER_KEY || null;
  if (ownerKey && !OWNER_KEY.test(ownerKey)) log(`HORNHOOF_OWNER_KEY is not a key, so this machine pins no owner. ${RUN_AGAIN}`);
  return {
    machineId,
    joinServer: joinServerOf(env.HORNHOOF_JOIN_SERVER),
    ticket: env.HORNHOOF_JOIN_TICKET || null,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    dir: KEEPER_DIR,
    commit: env.HORNHOOF_COMMIT || 'local',
    ports: publishedFrom(env),
    addresses: (env.HORNHOOF_ADDRESSES ?? '').split(',').map(address => address.trim()).filter(Boolean),
    hostname: env.HORNHOOF_HOSTNAME || null,
    ownerKey: ownerKey && OWNER_KEY.test(ownerKey) ? ownerKey : null,
  };
}
