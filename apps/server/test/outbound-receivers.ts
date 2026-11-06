import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createTls, type TLSSocket } from 'node:tls';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';

/* Certificates made for these tests only, for localhost until 2126. They protect nothing: nothing outside these tests
   trusts them. STRANGER is another certificate for the same name, which a client that trusts CERT must refuse. */
export const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUSrxVOVaqyr066W/lbF3gtABgntcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNjAwNTQyMloYDzIxMjYxMDEz
MDA1NDIyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARrkSH7y7rxhAZcljP/qPOkJZKjtEaR0PNhWASewc7JRcQTyx+dCyks
AkQ9b4CFSyGNXaLRt8UsB6UGAvGEkax/o28wbTAdBgNVHQ4EFgQUc4J27IgkaQsA
IXMzLtI2Vwg7TRMwHwYDVR0jBBgwFoAUc4J27IgkaQsAIXMzLtI2Vwg7TRMwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgBTYkjlrcJi9D6LYTddkNDOpuRrvrKPCG0R/+phxgP4ECIQCg
kRP/QUOOB4O8VckaCzgBQyKeqUEkUanPuitV+KLzQQ==
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIGS3byVKB6Omxgwaen0xs5HtheQoBMO8ddpjSlApo5JjoAoGCCqGSM49
AwEHoUQDQgAEa5Eh+8u68YQGXJYz/6jzpCWSo7RGkdDzYVgEnsHOyUXEE8sfnQsp
LAJEPW+AhUshjV2i0bfFLAelBgLxhJGsfw==
-----END EC PRIVATE KEY-----`;
export const STRANGER_CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUQ/nb/8suwVmTNvc2Tf8g+AzVFJowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNjAwNTQyMloYDzIxMjYxMDEz
MDA1NDIyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQKDPQJaRrbGRBfsC0NuPEQgESxvqmDZ7GXgky7St/CC+GWQBphS1kV
dEV9NX4TJQnsrxVGJ8Ro46n/rnPz1yFYo28wbTAdBgNVHQ4EFgQUVBvPViWO7Gsv
IgK4HPysPgfTqv0wHwYDVR0jBBgwFoAUVBvPViWO7GsvIgK4HPysPgfTqv0wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSQAwRgIhAIDbRG3Fim8htAvbeEcgDOJR4OgnhBE0D7L+KKq8hfVGAiEA
xTQsaMLlIbYNE6gRhGrKzKCE4yGiS/CJ63PLROwgvbk=
-----END CERTIFICATE-----`;
const STRANGER_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIKIoVys5/SpwHWkoBXK4g6sB4g9CwZADQGUIaBof+0zAoAoGCCqGSM49
AwEHoUQDQgAECgz0CWka2xkQX7AtDbjxEIBEsb6pg2exl4JMu0rfwgvhlkAaYUtZ
FXRFfTV+EyUJ7K8VRifEaOOp/65z89chWA==
-----END EC PRIVATE KEY-----`;

/* A marker that stands for a real secret: no test may find it anywhere a person or an agent could read. */
export const PASSWORD = 'synthetic-transport-secret-5f3c';
export const USERNAME = 'sender@acme.test';

const portOf = (server: { address(): AddressInfo | string | null }) => (server.address() as AddressInfo).port;
const keysOf = (stranger?: boolean) => (stranger ? { key: STRANGER_KEY, cert: STRANGER_CERT } : { key: KEY, cert: CERT });
const closeTls = (server: { close(callback: () => void): unknown }) => new Promise<void>(resolve => server.close(() => resolve()));
const closeHttps = (server: HttpsServer) => {
  server.closeAllConnections();
  return closeTls(server);
};
const readAll = async (stream: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

type SmtpOptions = { secure?: boolean; startTls?: boolean; stranger?: boolean; refuseRecipient?: boolean; refuseMessage?: number; reply?: string };
type Received = { from: string; to: string[]; raw: Buffer };
type SmtpSeen = { connections: number; logins: string[]; messages: Received[] };

const refusal = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode });
const isRightLogin = (auth: SMTPServerAuthentication) => auth.username === USERNAME && auth.password === PASSWORD;
const answerLogin = (auth: SMTPServerAuthentication, callback: (failure: Error | null | undefined, answer?: { user: string }) => void) => (isRightLogin(auth) ? callback(null, { user: USERNAME }) : callback(refusal('Bad login', 535)));
const recipientFailure = (refuse?: boolean) => (refuse ? refusal('No such mailbox', 550) : undefined);
const withoutStartTls = (options: SmtpOptions) => (options.startTls === false ? { disabledCommands: ['STARTTLS'], allowInsecureAuth: true } : {});
const senderOf = (session: SMTPServerSession) => (session.envelope.mailFrom || { address: '' }).address;
const received = (session: SMTPServerSession, raw: Buffer): Received => ({ from: senderOf(session), to: session.envelope.rcptTo.map(entry => entry.address), raw });

function answerMessage(options: SmtpOptions, seen: SmtpSeen, session: SMTPServerSession, raw: Buffer, callback: (failure?: Error | null, reply?: string) => void) {
  if (options.refuseMessage) return callback(refusal('Refused', options.refuseMessage));
  seen.messages.push(received(session, raw));
  callback(null, options.reply);
}

/* A real authenticated SMTP server on this machine, which counts what reaches it. */
export async function smtpReceiver(given: SmtpOptions = {}) {
  const options = { reply: 'queued as 7A1', ...given };
  const seen: SmtpSeen = { connections: 0, logins: [], messages: [] };
  const server = new SMTPServer({
    ...keysOf(options.stranger),
    ...withoutStartTls(options),
    secure: options.secure === true,
    logger: false,
    onConnect(_session, callback) {
      seen.connections += 1;
      callback();
    },
    onAuth(auth, _session, callback) {
      seen.logins.push(String(auth.username));
      answerLogin(auth, callback);
    },
    onRcptTo(_address, _session, callback) {
      callback(recipientFailure(options.refuseRecipient));
    },
    onData(stream, session, callback) {
      void readAll(stream).then(raw => answerMessage(options, seen, session, raw, callback));
    },
  });
  server.on('error', () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  return { port: portOf(server.server), seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

type Script = 'close_after_message' | 'silent_after_message' | 'close_at_mail';
type Talk = { script: Script; seen: { messages: number }; socket: TLSSocket; inMessage: boolean; held: string };

const REPLIES: Record<string, string> = { EHLO: '250-scripted\r\n250 AUTH PLAIN\r\n', AUTH: '235 ok\r\n', MAIL: '250 ok\r\n', RCPT: '250 ok\r\n', DATA: '354 go on\r\n' };
const AT_END_OF_WORDS: Record<Script, (socket: TLSSocket) => void> = { close_after_message: socket => socket.destroy(), silent_after_message: () => undefined, close_at_mail: () => undefined };
const dropsAt = (talk: Talk, verb: string) => verb === 'MAIL' && talk.script === 'close_at_mail';

function answerCommand(talk: Talk, verb: string) {
  if (dropsAt(talk, verb)) return talk.socket.destroy();
  talk.inMessage = verb === 'DATA';
  talk.socket.write(`${REPLIES[verb]}`);
}

function heardCommand(talk: Talk) {
  const verb = talk.held.trim().slice(0, 4);
  talk.held = '';
  answerCommand(talk, verb);
}

function heardWords(talk: Talk) {
  if (!talk.held.endsWith('\r\n.\r\n')) return;
  talk.seen.messages += 1;
  AT_END_OF_WORDS[talk.script](talk.socket);
}

function hear(talk: Talk, chunk: Buffer) {
  talk.held += chunk.toString('latin1');
  (talk.inMessage ? heardWords : heardCommand)(talk);
}

/* A TLS server that speaks just enough SMTP to fail at the exact moment a test names, which a whole server cannot do. */
export async function scriptedSmtp(script: Script) {
  const seen = { messages: 0 };
  const server = createTls(keysOf(), socket => {
    const talk: Talk = { script, seen, socket, inMessage: false, held: '' };
    socket.on('error', () => undefined);
    socket.write('220 scripted ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => hear(talk, chunk));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: portOf(server), seen, close: () => closeTls(server) };
}

export type HookRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
type HookAnswer = { status: number; body?: string; headers?: Record<string, string> } | 'silence' | 'destroy';

const WITHOUT_AN_ANSWER: Record<'silence' | 'destroy', (request: IncomingMessage) => void> = { silence: () => undefined, destroy: request => request.socket.destroy() };

function respond(reply: HookAnswer, request: IncomingMessage, response: ServerResponse) {
  if (typeof reply === 'string') return WITHOUT_AN_ANSWER[reply](request);
  response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
  response.end(reply.body);
}

const hookRequest = (request: IncomingMessage, body: Buffer): HookRequest => ({ method: String(request.method), url: String(request.url), headers: request.headers, body: body.toString('utf8') });

/* A real HTTPS receiver on this machine, which records every request and answers as the test says. */
export async function hookReceiver(answer: (request: HookRequest) => HookAnswer, options: { stranger?: boolean } = {}) {
  const seen: HookRequest[] = [];
  const server = createHttps(keysOf(options.stranger), (request, response) => {
    void readAll(request as AsyncIterable<Buffer>).then(body => {
      const heard = hookRequest(request, body);
      seen.push(heard);
      respond(answer(heard), request, response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: portOf(server), url: `https://localhost:${portOf(server)}/hook`, seen, close: () => closeHttps(server) };
}

/* The first free port found and let go again: nothing listens there. */
export async function closedPort(): Promise<number> {
  const server = createTls(keysOf());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  await closeTls(server);
  return port;
}
