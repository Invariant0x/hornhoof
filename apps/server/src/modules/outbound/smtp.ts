import type { ReconcileOutcome, SendOutcome, TransportAdapter } from './delivery.js';

export type SmtpAccount = { host: string; port: number; security: 'tls' | 'starttls'; username: string; password: string; from: string; ca?: string };
export type SmtpTimeouts = { connectMs: number; greetingMs: number; socketMs: number; totalMs: number };

export function smtpAdapter(_timeouts?: Partial<SmtpTimeouts>): TransportAdapter<SmtpAccount> {
  return {
    send: async (): Promise<SendOutcome> => ({ kind: 'unknown', safeCode: 'connection_lost' }),
    reconcile: async (): Promise<ReconcileOutcome> => ({ kind: 'pending' }),
  };
}
