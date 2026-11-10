import { NETWORK_ID } from '../network/ids.js';
import { addressesIn } from './addresses.js';
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
};

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
export function workerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const machineId = env.HORNHOOF_MACHINE_ID ?? '';
  if (!NETWORK_ID.test(machineId)) throw new Error(`HORNHOOF_MACHINE_ID is not set. ${RUN_AGAIN}`);
  return {
    machineId,
    joinServer: joinServerOf(env.HORNHOOF_JOIN_SERVER),
    ticket: env.HORNHOOF_JOIN_TICKET || null,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    dir: KEEPER_DIR,
    commit: env.HORNHOOF_COMMIT || 'local',
    ports: publishedFrom(env),
    addresses: addressesIn(env),
  };
}
