import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { acceptedWith, definitelyNot, isOneAddress, isSendable, isTlsFailure, unknownOutcome, type SafeCode, type SealedPayload, type SendOutcome, type TransportAdapter } from './delivery.js';

export type SmtpAccount = { host: string; port: number; security: 'tls' | 'starttls'; username: string; password: string; from: string; ca?: string };
export type SmtpTimeouts = { connectMs: number; greetingMs: number; socketMs: number; totalMs: number };

type SmtpFailure = Error & { code?: string; originalCode?: string; command?: string; responseCode?: number };
type Mail = { envelope: { from: string; to: string[] }; message: Buffer };

const DEFAULT_TIMEOUTS: SmtpTimeouts = { connectMs: 15_000, greetingMs: 15_000, socketMs: 60_000, totalMs: 120_000 };

const domainOf = (address: string): string => address.slice(address.indexOf('@') + 1);

/* The client refuses to log in without TLS: STARTTLS is required when the connection does not start with it. */
const connectionOptions = (account: SmtpAccount, timeouts: SmtpTimeouts) => ({
  host: account.host,
  port: account.port,
  secure: account.security === 'tls',
  requireTLS: account.security === 'starttls',
  name: domainOf(account.from),
  tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, ca: account.ca },
  connectionTimeout: timeouts.connectMs,
  greetingTimeout: timeouts.greetingMs,
  socketTimeout: timeouts.socketMs,
  logger: false,
  debug: false,
});

function connectingCode(failure: SmtpFailure): SafeCode {
  if (failure.code === 'EAUTH') return 'auth_refused';
  if (failure.code === 'ETLS' || isTlsFailure(failure.originalCode)) return 'tls_refused';
  return failure.code === 'ETIMEDOUT' ? 'connect_timeout' : 'connect_failed';
}

const isRefusalReply = (code: number | undefined): boolean => code !== undefined && code >= 400 && code < 600;

/* Once sending began only a refusal from the server is proof. Whatever else ends the talk may have come after the
   server took the message. */
function sendingOutcome(failure: SmtpFailure): SendOutcome {
  if (failure.code === 'EENVELOPE') return definitelyNot(failure.command === 'RCPT TO' ? 'recipient_refused' : 'message_refused');
  if (failure.code === 'EMESSAGE' && isRefusalReply(failure.responseCode)) return definitelyNot('message_refused');
  return unknownOutcome(failure.code === 'ETIMEDOUT' ? 'timeout' : 'connection_lost');
}

/* One connection, one login, one message, no retry. The promise takes the first outcome: the client reports one failure
   both as an event and to the callback in flight. */
function deliver(mail: Mail, account: SmtpAccount, timeouts: SmtpTimeouts): Promise<SendOutcome> {
  return new Promise(resolve => {
    const connection = new SMTPConnection(connectionOptions(account, timeouts));
    let sending = false;
    const fail = (failure: SmtpFailure) => {
      clearTimeout(limit);
      resolve(sending ? sendingOutcome(failure) : definitelyNot(connectingCode(failure)));
      connection.close();
    };
    const limit = setTimeout(() => fail(Object.assign(new Error('Out of time'), { code: 'ETIMEDOUT' })), timeouts.totalMs);
    const send = () => {
      sending = true;
      connection.send(mail.envelope, mail.message, (failure, info) => {
        if (failure) return fail(failure);
        clearTimeout(limit);
        resolve(acceptedWith(info!.response));
        connection.quit();
      });
    };
    connection.on('error', fail);
    connection.connect(failure => {
      if (failure) return fail(failure);
      connection.login({ user: account.username, pass: account.password }, refused => (refused ? fail(refused) : send()));
    });
  });
}

/* Plain words only: no file or link is ever read to build a message, and there is one recipient and nothing else. */
const compose = (attemptId: string, payload: SealedPayload, from: string): Promise<Buffer> => new MailComposer({
  from,
  to: payload.recipient,
  subject: payload.subject,
  text: payload.text,
  messageId: `<${attemptId}@${domainOf(from)}>`,
  textEncoding: 'base64',
  disableFileAccess: true,
  disableUrlAccess: true,
}).compile().build();

export function smtpAdapter(timeouts: Partial<SmtpTimeouts> = {}): TransportAdapter<SmtpAccount> {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  return {
    send: async ({ attemptId, sealedPayload, configuredAccount: account }) => {
      if (!isSendable(attemptId, sealedPayload) || !isOneAddress(account.from)) return definitelyNot('invalid_payload');
      const message = await compose(attemptId, sealedPayload, account.from);
      return deliver({ envelope: { from: account.from, to: [sealedPayload.recipient] }, message }, account, limits);
    },
    /* SMTP offers no way to ask whether a message was taken: only a person can settle it. */
    reconcile: async () => unknownOutcome('no_readback'),
  };
}
