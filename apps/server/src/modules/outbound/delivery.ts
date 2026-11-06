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

/* The frozen message as a transport gets it: one recipient, and words that are only ever data. This is the port the
   dispatcher binds to the frozen message of #317 A; a transport never reads the message from anywhere else. */
export type SealedPayload = { recipient: string; subject: string; text: string };

export type TransportAdapter<Account> = {
  send(attempt: { attemptId: string; sealedPayload: SealedPayload; configuredAccount: Account }): Promise<SendOutcome>;
  reconcile(attempt: { attemptId: string; providerReceipt?: string; configuredAccount: Account }): Promise<ReconcileOutcome>;
};

const MAX_RECEIPT = 512;
const MAX_ADDRESS = 254;
/* A short plain list, not the whole of the address grammar: what is left out is refused before anything is sent. */
const ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ATTEMPT = /^[A-Za-z0-9-]{1,128}$/;
const LINE_BREAKING = /[\p{Cc}\u2028\u2029]/u;
const TLS_FAILURE = /CERT|SSL|TLS|SIGNATURE|ISSUER/;

export const definitelyNot = (safeCode: SafeCode): SendOutcome => ({ kind: 'definitely_not_accepted', safeCode });
export const unknownOutcome = (safeCode: SafeCode): SendOutcome => ({ kind: 'unknown', safeCode });
export const acceptedWith = (receipt: string): SendOutcome => ({ kind: 'accepted', providerReceipt: cleanReceipt(receipt), acceptedAt: new Date().toISOString() });

/* A receipt comes from outside: it is kept as one short line, and never read as anything else. */
const cleanReceipt = (receipt: string): string => receipt.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\p{Cc}/gu, '').trim().slice(0, MAX_RECEIPT);

export const isTlsFailure = (code: string | undefined): boolean => TLS_FAILURE.test(code ?? '');
export const isOneAddress = (value: string): boolean => value.length <= MAX_ADDRESS && ADDRESS.test(value);

const isWellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
const isOneLine = (value: string): boolean => isWellFormed(value) && !LINE_BREAKING.test(value);
const isInertText = (value: string): boolean => value !== '' && isWellFormed(value) && !/(?![\t\n])\p{Cc}/u.test(value.replaceAll('\r\n', '\n'));

/* Checked before any connection: what fails here cannot have reached anyone. */
export const isSendable = (attemptId: string, payload: SealedPayload): boolean => ATTEMPT.test(attemptId) && isOneAddress(payload.recipient) && isOneLine(payload.subject) && isInertText(payload.text);
