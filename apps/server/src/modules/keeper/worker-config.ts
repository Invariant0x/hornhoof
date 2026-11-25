import { isP256 } from '../computer/owner-key.js';
import { hostOsOf, NETWORK_ID, type HostOs } from '../network/ids.js';
import { addressesIn } from './addresses.js';
import { SURVIVOR_MS } from './holder.js';
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
  /* The key of the machine's owner, as the command they ran here carried it: the keeper pins it once it joined. */
  ownerKey: string | null;
  /* The system of the computer, as the installer wrote it down. */
  hostOs: HostOs | null;
  /* For how long this machine is without a leader before it looks for a server restored from the recovery file. */
  survivorMs: number;
  /* The folder of the file store's volume; left out, this machine holds none of the company's files. */
  filesDir?: string;
};

/* HORNHOOF_SURVIVOR_S, which a stand sets to wait less: a whole number of seconds from 10 to an hour. */
function survivorMsOf(value: string | undefined): number {
  const seconds = /^\d{2,4}$/.test(value ?? '') ? Number(value) : 0;
  return seconds >= 10 && seconds <= 3600 ? seconds * 1000 : SURVIVOR_MS;
}

export const RUN_AGAIN = 'Run the join command from Hornhoof on this machine again.';
const NO_PIN = `HORNHOOF_OWNER_KEY is not a key, so this machine pins no owner. ${RUN_AGAIN}`;

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
  if (!NETWORK_ID.test(machineId)) throw new Error(`HORNHOOF_MACHINE_ID is not set. ${RUN_AGAIN}`);
  const ownerKey = env.HORNHOOF_OWNER_KEY || null;
  if (ownerKey && !isP256(ownerKey)) log(NO_PIN);
  return {
    machineId,
    joinServer: joinServerOf(env.HORNHOOF_JOIN_SERVER),
    ticket: env.HORNHOOF_JOIN_TICKET || null,
    controlDir: env.HORNHOOF_CONTROL_DIR || '/control',
    dir: KEEPER_DIR,
    commit: env.HORNHOOF_COMMIT || 'local',
    ports: publishedFrom(env),
    addresses: addressesIn(env),
    ownerKey: ownerKey && isP256(ownerKey) ? ownerKey : null,
    hostOs: hostOsOf(env.HORNHOOF_HOST_OS),
    survivorMs: survivorMsOf(env.HORNHOOF_SURVIVOR_S),
    ...(env.FILES_DIR ? { filesDir: env.FILES_DIR } : {}),
  };
}
