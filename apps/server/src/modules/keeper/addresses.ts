import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

/* What the updater found on the machine's own network interfaces, which the keeper's container cannot see. at: seconds. */
export const ADDRESSES_FILE = 'addresses.json';
const FRESH_MS = 5 * 60_000;
const MOST = 8;

const Found = z.object({ at: z.number(), addresses: z.array(z.string()) });

/* The private networks, and the ranges kept for documentation, which only tests use. */
const PRIVATE = [/^10\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];

/* An IPv4 address of a private network: one a machine has on its local network, and never one of the internet. */
export function isPrivate(address: string): boolean {
  return isIPv4(address) && PRIVATE.some(range => range.test(address));
}

/* The machine's addresses as the installer wrote them into its environment. */
export const addressesIn = (env: NodeJS.ProcessEnv): string[] => (env.HORNHOOF_ADDRESSES ?? '').split(',').map(address => address.trim()).filter(Boolean);

function found(controlDir: string, now: Date): string[] {
  try {
    const file = Found.parse(JSON.parse(readFileSync(join(controlDir, ADDRESSES_FILE), 'utf8')));
    return Math.abs(now.getTime() - file.at * 1000) <= FRESH_MS ? file.addresses : [];
  } catch {
    return [];
  }
}

/* Where this machine can be dialed on its local networks: what the updater found a moment ago, then what the installer
   wrote down, then what the company's server saw it come from. A list the updater left long ago is of another network by
   now. Private addresses only, since nothing else is one of its own, each once and eight at most. */
export function ownAddresses(opts: { controlDir: string; env: string[]; seen: string[]; now?: Date }): string[] {
  const all = [...found(opts.controlDir, opts.now ?? new Date()), ...opts.env, ...opts.seen].map(address => address.trim());
  return [...new Set(all.filter(isPrivate))].slice(0, MOST);
}
