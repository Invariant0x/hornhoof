/* The keeper signs the one-use ticket and the computer it is joining as. */
export const joinMessage = (ticket: string, networkId: string): string => `hornhoof-join:${ticket}:${networkId}`;
