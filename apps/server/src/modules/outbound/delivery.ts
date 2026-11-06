/* What a transport tells its dispatcher about one attempt. "accepted" means the transport took the message, not that
   anyone received it. "unknown" means it may have left: it keeps its quota and its account, and nothing sends it again
   blindly. A transport only says "definitely_not_accepted" when it holds the proof. */
export type SafeCode =
  | 'invalid_payload'
  | 'endpoint_invalid'
  | 'address_refused'
  | 'connect_failed'
  | 'connect_timeout'
  | 'tls_refused'
  | 'auth_refused'
  | 'recipient_refused'
  | 'message_refused'
  | 'receiver_refused'
  | 'receiver_error'
  | 'redirect_refused'
  | 'bad_receipt'
  | 'timeout'
  | 'connection_lost'
  | 'no_readback';

export type SendOutcome =
  | { kind: 'accepted'; providerReceipt: string; acceptedAt: string }
  | { kind: 'definitely_not_accepted'; safeCode: SafeCode }
  | { kind: 'unknown'; safeCode: SafeCode };
export type ReconcileOutcome = SendOutcome | { kind: 'pending' };

/* The frozen message as a transport gets it: one recipient, and text that is only ever data. */
export type SealedPayload = { recipient: string; subject: string; text: string };

export type TransportAdapter<Account> = {
  send(attempt: { attemptId: string; sealedPayload: SealedPayload; configuredAccount: Account }): Promise<SendOutcome>;
  reconcile(attempt: { attemptId: string; providerReceipt?: string; configuredAccount: Account }): Promise<ReconcileOutcome>;
};
