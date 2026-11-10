/* A machine's id in the company's network, as install.sh writes it: the hex of a hash, in the length today's installs
   have or the one older installs had. */
export const NETWORK_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
