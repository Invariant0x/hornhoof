import { createHash, randomBytes } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');

/* Only hashes of session, invite and join tokens are stored. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
