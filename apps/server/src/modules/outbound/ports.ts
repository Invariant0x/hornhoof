import type { CertifiedCheck, CheckBinding, GateCode, InvalidationCode, VerifiedEvaluation } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { RunModelCheck } from '../model-checks/run.js';

/* The private seams of the outbound gateway between its kernel, its sender and its checks (#403, sections 8 and 10). Types
   only: no way around the kernel starts here, and a value of these types grants nothing by itself. */

/* What a transport says about one attempt, in codes that never carry a provider's words. */
export type SafeCode =
  | 'invalid_payload' | 'endpoint_invalid' | 'address_refused' | 'connect_failed' | 'connect_timeout' | 'tls_refused' | 'auth_refused' | 'recipient_refused'
  | 'message_refused' | 'receiver_refused' | 'receiver_error' | 'redirect_refused' | 'bad_receipt' | 'timeout' | 'connection_lost' | 'no_readback' | 'person_confirmed' | 'settings_changed';

/* "accepted" means the transport took the message, not that anyone received it. "unknown" means it may have left: it keeps
   its quota and its account, and nothing sends it again blindly. "definitely_not_accepted" needs proof. */
export type SendOutcome =
  | { kind: 'accepted'; providerReceipt: string; acceptedAt: string }
  | { kind: 'definitely_not_accepted'; safeCode: SafeCode }
  | { kind: 'unknown'; safeCode: SafeCode };
export type ReconcileOutcome = SendOutcome | { kind: 'pending' };

/* The frozen message as a transport gets it: one recipient, and words that are only ever data. */
export type SealedPayload = { recipient: string; subject: string; text: string };

export type TransportAdapter<Account> = {
  send(attempt: { attemptId: string; sealedPayload: SealedPayload; configuredAccount: Account }): Promise<SendOutcome>;
  reconcile(attempt: { attemptId: string; providerReceipt?: string; configuredAccount: Account }): Promise<ReconcileOutcome>;
};

/* The kernel's last look before anything leaves: current sources, consent, suppression, approval, certificate, account and
   channel generation. It turns an unused reservation into one attempt; only the trusted dispatcher ever calls it. */
export type DispatchAdmission =
  | { kind: 'begun'; attemptId: string; accountId: string; configGeneration: number; sealedPayload: SealedPayload }
  | { kind: 'refused'; reasonCodes: GateCode[] };
export type BeginDispatch = (ctx: Ctx, messageId: string, expectedRevision: number) => Promise<DispatchAdmission>;
export type SettleAttempt = (ctx: Ctx, attemptId: string, outcome: SendOutcome) => Promise<void>;

/* Where the checks made by a model meet the gate. No agent tool reaches any of these. */
export type ModelCheckPorts = {
  runModelCheck: RunModelCheck;
  getCertifiedCheck(binding: CheckBinding): Promise<CertifiedCheck | null>;
  invalidateCertification(bindingDigest: string, reason: InvalidationCode): Promise<void>;
  publishEvaluation(evaluation: VerifiedEvaluation): Promise<CertifiedCheck | null>;
};
