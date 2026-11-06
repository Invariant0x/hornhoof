import { once } from 'node:events';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createTls, type TLSSocket } from 'node:tls';
import { SMTPServer } from 'smtp-server';

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
const readAll = async (stream: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

type SmtpOptions = { secure?: boolean; startTls?: boolean; stranger?: boolean; refuseRecipient?: boolean; refuseMessage?: number; reply?: string };
type Received = { from: string; to: string[]; raw: Buffer };

const refusal = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode });

/* A real authenticated SMTP server on this machine, which counts what reaches it. */
export async function smtpReceiver(options: SmtpOptions = {}) {
  const seen = { connections: 0, logins: [] as string[], messages: [] as Received[] };
  const server = new SMTPServer({
    secure: options.secure === true,
    key: options.stranger ? STRANGER_KEY : KEY,
    cert: options.stranger ? STRANGER_CERT : CERT,
    disabledCommands: options.startTls === false ? ['STARTTLS'] : [],
    allowInsecureAuth: options.startTls === false,
    logger: false,
    onConnect(_session, callback) {
      seen.connections += 1;
      callback();
    },
    onAuth(auth, _session, callback) {
      seen.logins.push(auth.username ?? '');
      if (auth.username === USERNAME && auth.password === PASSWORD) return callback(null, { user: auth.username });
      callback(refusal('Bad login', 535));
    },
    onRcptTo(_address, _session, callback) {
      callback(options.refuseRecipient ? refusal('No such mailbox', 550) : undefined);
    },
    onData(stream, session, callback) {
      void readAll(stream).then(raw => {
        if (options.refuseMessage) return callback(refusal('Refused', options.refuseMessage));
        seen.messages.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map(r => r.address), raw });
        callback(null, options.reply ?? 'queued as 7A1');
      });
    },
  });
  server.on('error', () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  return { port: portOf(server.server), seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

type Script = 'close_after_message' | 'silent_after_message' | 'close_at_mail';

/* A TLS server that speaks just enough SMTP to fail at the exact moment a test names, which a whole server cannot do. */
export async function scriptedSmtp(script: Script) {
  const seen = { messages: 0 };
  const speak = (socket: TLSSocket) => {
    let inMessage = false;
    let held = '';
    socket.on('error', () => undefined);
    socket.write('220 scripted ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      held += chunk.toString('latin1');
      if (inMessage) {
        if (!held.endsWith('\r\n.\r\n')) return;
        seen.messages += 1;
        if (script === 'close_after_message') socket.destroy();
        return;
      }
      const line = held.trim();
      held = '';
      if (line.startsWith('EHLO')) socket.write('250-scripted\r\n250 AUTH PLAIN\r\n');
      else if (line.startsWith('AUTH')) socket.write('235 ok\r\n');
      else if (line.startsWith('MAIL')) {
        if (script === 'close_at_mail') socket.destroy();
        else socket.write('250 ok\r\n');
      } else if (line.startsWith('RCPT')) socket.write('250 ok\r\n');
      else if (line.startsWith('DATA')) {
        inMessage = true;
        socket.write('354 go on\r\n');
      }
    });
  };
  const server = createTls({ key: KEY, cert: CERT }, speak);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: portOf(server), seen, close: () => closeServer(server) };
}

const closeServer = (server: { close(callback: () => void): unknown; closeAllConnections?: () => void }) => {
  server.closeAllConnections?.();
  return new Promise<void>(resolve => server.close(() => resolve()));
};

export type HookRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
type HookAnswer = { status: number; body?: string; headers?: Record<string, string> } | 'silence' | 'destroy';

/* A real HTTPS receiver on this machine, which records every request and answers as the test says. */
export async function hookReceiver(answer: (request: HookRequest) => HookAnswer, options: { stranger?: boolean } = {}) {
  const seen: HookRequest[] = [];
  const server: HttpsServer = createHttps({ key: options.stranger ? STRANGER_KEY : KEY, cert: options.stranger ? STRANGER_CERT : CERT }, (req, res) => {
    void readAll(req as AsyncIterable<Buffer>).then(body => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.toString('utf8') };
      seen.push(request);
      const reply = answer(request);
      if (reply === 'silence') return;
      if (reply === 'destroy') return req.socket.destroy();
      res.writeHead(reply.status, reply.headers ?? { 'content-type': 'application/json' });
      res.end(reply.body ?? '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: portOf(server), url: `https://localhost:${portOf(server)}/hook`, seen, close: () => closeServer(server) };
}

/* The first free port found and let go again: nothing listens there. */
export async function closedPort(): Promise<number> {
  const server = createTls({ key: KEY, cert: CERT });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  await closeServer(server);
  return port;
}
