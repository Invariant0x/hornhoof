/* What a machine signs to ask for a renewal, and what the company's authority signs to answer it. The answer names the
   request, so one answer cannot stand for another. Both sides read these, the server's app and a worker's keeper, so
   they live apart from either. */
export const renewMessage = (machine: string, serial: string, at: string): string => `hornhoof-renew:${machine}:${serial}:${at}`;
export const renewedMessage = (machine: string, serial: string, at: string, payload: string): string =>
  `hornhoof-renewed:${machine}:${serial}:${at}:${payload}`;

/* payload: JSON text. signature: Ed25519 by the company's authority, in base64. */
export type Signed = { payload: string; signature: string };
