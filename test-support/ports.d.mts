import type { Server } from 'node:net';
export const CORRIDOR: Readonly<{ first: number; size: number; shares: number }>;
export function corridorShare(env?: NodeJS.ProcessEnv, pid?: number): { first: number; last: number };
export function listenIn(server: Server, host?: string): Promise<number>;
export function testPort(host?: string): Promise<number>;
export function listenAt<T>(start: (port: number) => Promise<T>, host?: string): Promise<T>;
