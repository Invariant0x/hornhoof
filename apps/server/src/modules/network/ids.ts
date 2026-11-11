/* A machine's id in the company's network, as install.sh writes it: the hex of a hash, in the length today's installs
   have or the one older installs had. */
export const NETWORK_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

/* The system of a computer as install.sh names it; anything else is not known. */
export type HostOs = 'linux' | 'darwin';
export const hostOsOf = (said: string | undefined): HostOs | null => (said === 'linux' || said === 'darwin' ? said : null);
