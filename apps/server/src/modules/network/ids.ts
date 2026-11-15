/* A machine's id in the company's network, as install.sh writes it: the hex of a hash, in the length today's installs
   have or the one older installs had. */
export const NETWORK_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/;
/* The local network an IPv4 address is on, as two machines behind one home router share it: its first three numbers.
   None for anything else. */
export const subnetOf = (address: string): string | null => {
  const parts = IPV4.exec(address);
  return parts ? `${parts[1]}.${parts[2]}.${parts[3]}` : null;
};
/* Two IPv4 addresses on one such network. */
export const sameSubnet = (a: string, b: string): boolean => subnetOf(a) !== null && subnetOf(a) === subnetOf(b);

/* The system of a computer as install.sh names it; anything else is not known. */
export type HostOs = 'linux' | 'darwin';
export const hostOsOf = (said: string | undefined): HostOs | null => (said === 'linux' || said === 'darwin' ? said : null);
