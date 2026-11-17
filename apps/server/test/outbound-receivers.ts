import { createServer as createHttp, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { createServer as createPlain, type AddressInfo, type Socket } from 'node:net';
import { createServer as createTls, type TLSSocket } from 'node:tls';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import { listenIn } from '../../../test-support/ports.mjs';

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
  await listenIn(server.server);
  return { port: portOf(server.server), seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

type Script = keyof typeof SCRIPTS;
type Talk = { script: typeof AS_USUAL; seen: { messages: number }; socket: TLSSocket; inMessage: boolean; held: string };

const REPLIES: Record<string, string> = { EHLO: '250-scripted\r\n250 AUTH PLAIN\r\n', AUTH: '235 ok\r\n', MAIL: '250 ok\r\n', RCPT: '250 ok\r\n', DATA: '354 go on\r\n' };
const quiet: (socket: TLSSocket) => unknown = () => undefined;
const drop = (socket: TLSSocket) => socket.destroy();
const AS_USUAL = { atStart: quiet, greeting: '220 scripted ESMTP\r\n', replies: REPLIES, dropVerb: '', atEnd: quiet };
const SCRIPTS = {
  close_after_message: { atEnd: drop },
  silent_after_message: {},
  odd_reply_after_message: { atEnd: (socket: TLSSocket) => socket.write('354 what now\r\n') },
  close_at_mail: { dropVerb: 'MAIL' },
  refuse_at_mail: { replies: { ...REPLIES, MAIL: '550 not from you\r\n' } },
  refuse_at_data: { replies: { ...REPLIES, DATA: '554 not now\r\n' } },
  no_greeting: { greeting: '' },
  close_at_greeting: { greeting: '', atStart: drop },
};

function answerCommand(talk: Talk, verb: string) {
  if (verb === talk.script.dropVerb) return talk.socket.destroy();
  talk.inMessage = verb === 'DATA';
  talk.socket.write(`${talk.script.replies[verb]}`);
}

function heardCommand(talk: Talk) {
  const verb = talk.held.trim().slice(0, 4);
  talk.held = '';
  answerCommand(talk, verb);
}

function heardWords(talk: Talk) {
  if (!talk.held.endsWith('\r\n.\r\n')) return;
  talk.seen.messages += 1;
  talk.held = '';
  talk.script.atEnd(talk.socket);
}

function hear(talk: Talk, chunk: Buffer) {
  talk.held += chunk.toString('latin1');
  (talk.inMessage ? heardWords : heardCommand)(talk);
}

/* A TLS server that speaks just enough SMTP to fail at the exact moment a test names, which a whole server cannot do. */
export async function scriptedSmtp(name: Script) {
  const seen = { messages: 0 };
  const script = { ...AS_USUAL, ...SCRIPTS[name] };
  const server = createTls(keysOf(), socket => {
    const talk: Talk = { script, seen, socket, inMessage: false, held: '' };
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => hear(talk, chunk));
    socket.write(script.greeting);
    script.atStart(socket);
  });
  await listenIn(server);
  return { port: portOf(server), seen, close: () => closeTls(server) };
}

export type HookRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
type HookAnswer = { status: number; body?: string; headers?: Record<string, string> } | 'silence' | 'destroy' | 'cut';

function cutOff(request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, { 'content-length': '1000' });
  response.write('{"attemptId":', () => request.socket.destroy());
}

const WITHOUT_AN_ANSWER: Record<'silence' | 'destroy' | 'cut', (request: IncomingMessage, response: ServerResponse) => void> = { silence: () => undefined, destroy: request => request.socket.destroy(), cut: cutOff };

function respond(reply: HookAnswer, request: IncomingMessage, response: ServerResponse) {
  if (typeof reply === 'string') return WITHOUT_AN_ANSWER[reply](request, response);
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
  await listenIn(server);
  return { port: portOf(server), url: `https://localhost:${portOf(server)}/hook`, seen, close: () => closeHttps(server) };
}

/* A plain TCP port that takes connections and never starts TLS. */
export async function silentPort() {
  const sockets: Socket[] = [];
  const server = createPlain(socket => sockets.push(socket.on('error', () => undefined)));
  await listenIn(server);
  const close = () => {
    sockets.forEach(socket => socket.destroy());
    return closeTls(server);
  };
  return { port: portOf(server), close };
}

/* The part of a raw message after its headers, as the words it carries. */
export const parts = (raw: Buffer) => {
  const text = raw.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  return { headers: text.slice(0, end).replace(/\r\n[ \t]+/g, ' '), body: text.slice(end + 4) };
};
export const header = (headers: string, name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(headers)?.[1];
const isBase64 = (headers: string) => String(header(headers, 'content-transfer-encoding')).toLowerCase() === 'base64';
export const wordsOf = (raw: Buffer) => {
  const { headers, body } = parts(raw);
  if (isBase64(headers)) return Buffer.from(body, 'base64').toString('utf8');
  return body.replace(/\r\n/g, '\n');
};
export const subjectOf = (raw: Buffer) => (header(parts(raw).headers, 'subject') ?? '').replace(/=\?utf-8\?B\?([^?]+)\?=\s?/gi, (_all, word: string) => Buffer.from(word, 'base64').toString('utf8'));

/* A vendor's API stands in as a real HTTP server on this machine, so a call is seen as it really goes. */
export type VendorCall = { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
export type VendorAnswer = (response: ServerResponse, call: VendorCall) => void;

export const vendorJson = (status: number, value: unknown): VendorAnswer => response => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

export async function vendorApi(answer: VendorAnswer) {
  const heard: VendorCall[] = [];
  const server = createHttp((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const call = { url: String(request.url), headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> };
      heard.push(call);
      answer(response, call);
    });
  });
  await listenIn(server);
  const close = async () => {
    server.closeAllConnections();
    server.close();
  };
  return { heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/call`, close };
}
