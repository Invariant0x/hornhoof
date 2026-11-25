import { hashToken } from '../../crypto/tokens.js';

/* The keeper signs the one-use ticket and the computer it is joining as. */
export const joinMessage = (ticket: string, networkId: string): string => `hornhoof-join:${ticket}:${networkId}`;

/* The id install.sh gives a computer's keeper: the hash of the key the computer joined with. */
export const hostIdOf = (machineKey: string): string => hashToken(`hornhoof-host:${machineKey}`);
