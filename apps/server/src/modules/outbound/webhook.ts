import type { ReconcileOutcome, SendOutcome, TransportAdapter } from './delivery.js';

export type WebhookAccount = { endpoint: string; signingKey: string; readback?: boolean; ca?: string };
export type WebhookOptions = { timeoutMs: number; mayReach: (address: string) => boolean };

export const isPublicAddress = (_address: string): boolean => true;

export function webhookAdapter(_options?: Partial<WebhookOptions>): TransportAdapter<WebhookAccount> {
  return {
    send: async (): Promise<SendOutcome> => ({ kind: 'unknown', safeCode: 'connection_lost' }),
    reconcile: async (): Promise<ReconcileOutcome> => ({ kind: 'unknown', safeCode: 'connection_lost' }),
  };
}
