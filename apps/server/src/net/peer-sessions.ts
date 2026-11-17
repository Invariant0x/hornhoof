import { X509Certificate } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';
import type { Duplex, Readable } from 'node:stream';
import tls from 'node:tls';
import { z } from 'zod';
import { MACHINE_ROLES, type LinkPath } from '../db/schema.js';
import type { HeldCertificate } from '../modules/keeper/certificate.js';
import type { MachineKey } from '../modules/keeper/machine-keys.js';
import { RoundTrips } from '../modules/keeper/round-trips.js';
import { certFacts } from '../modules/network/authority.js';
import { sameSubnet } from '../modules/network/ids.js';
import { APP_AUTHORITY, DB_AUTHORITY, PEER_PATHS } from './peer-server.js';
import { streamDeadline } from './stream-deadline.js';

/* A data machine to keep a session to. machine: its row's id, which its certificate names. networkId: its keeper's id,
   which its services at the relay are named after. relayPort: the loopback port this keeper's visitor frpc opens to it,
   when there is one. */
export type DialTarget = { machine: string; networkId: string; addresses: string[]; peerPort: number | null; relayPort: number | null };
export type Hello = z.infer<typeof HelloBody>;
export type PeerSessionsOptions = {
  held: () => HeldCertificate | null;
  key: MachineKey;
  /* The certificates this machine was told are revoked: a data machine that shows one is not dialed further. */
  revoked: () => ReadonlySet<string>;
  /* This machine's own addresses, to tell a data machine on its network from one elsewhere. */
  own: () => string[];
  log: (line: string) => void;
  /* What one address gets to connect and say hello. */
  connectMs?: number;
  /* How often a machine with no session is dialed again. */
  everyMs?: number;
  helloMs?: number;
  /* How often the direct path is tried again while the session goes through the relay. */
  directEveryMs?: number;
  /* How often a session is pinged, so that one on which nothing else goes still brings bytes while its link holds. */
  pingMs?: number;
  /* A session on which nothing came for this long is ended. */
  silentMs?: number;
  /* A stream of its own on which no byte moves for this long is cut. */
  streamIdleMs?: number;
  /* Called when a session came or went, or a hello said something new. */
  changed?: () => void;
};

const CONNECT_MS = 3000;
const EVERY_MS = 5000;
const HELLO_MS = 10_000;
const DIRECT_EVERY_MS = 60_000;
const PING_MS = 15_000;
const STREAM_IDLE_MS = 30_000;
/* A session ends on silence alone: a late hello or ping does not end one on which bytes still come, as on a slow link a
   long copy's bytes go ahead of their answers. Half a minute is three hellos and two pings without a byte of answer on a
   link that works, and as long as one of its streams may stand still; a copy at 20 KB/s brings bytes every second. */
const SILENT_MS = STREAM_IDLE_MS;
/* How often a session is looked at for bytes that came on it. */
const LISTEN_MS = 1000;
const WINDOW = 1024 * 1024;
const HELLO_BYTES = 64 * 1024;
const ASK_MS = 5000;
const ASK_BYTES = 256 * 1024;
const LOOPBACK = '127.0.0.1';
const NO_LEADER = 'No leader of the company is in reach.';
const NO_SESSION = 'No session to that machine.';

/* term: the term a leading keeper leads under. sync: the machine its commits wait for, when the relay's record names
   one. moving: the machine a planned switch hands the server to, while it does. A keeper from before these says none. */
const HelloBody = z.object({
  machine: z.string(), role: z.enum(MACHINE_ROLES), lead: z.boolean(), commit: z.string(), seen: z.string(),
  term: z.object({ number: z.number().int(), machine: z.string(), split: z.boolean() }).nullish(),
  sync: z.string().nullish(),
  moving: z.string().nullish(),
});

/* Of the machines whose hello says they lead, the one that leads under the highest term, by its number and then its
   machine; a hello that names no term counts below every term. */
export function highestLead<T extends { hello: Hello }>(said: T[]): T | undefined {
  const above = (a: Hello['term'], b: Hello['term']): boolean => Boolean(a) && (!b || a!.number > b.number || (a!.number === b.number && a!.machine > b.machine));
  let best: T | undefined;
  for (const one of said) if (one.hello.lead && (!best || above(one.hello.term, best.hello.term))) best = one;
  return best;
}

/* asking: a hello is on its way. pinged: the last ping was answered. read: the bytes that came on its connection so far.
   bytes and heard: what read said at the last look, and when it last grew. why: why this side ended it. */
type Session = {
  h2: ClientHttp2Session;
  path: LinkPath;
  hello: Hello;
  timers: NodeJS.Timeout[];
  asking: boolean;
  pinged: boolean;
  read: () => number;
  bytes: number;
  heard: number;
  why?: string;
};

/* A session that said hello, to be kept: what came on its connection counts from now. */
export function heldSession(h2: ClientHttp2Session, path: LinkPath, hello: Hello, read: () => number): Session {
  return { h2, path, hello, timers: [], asking: false, pinged: true, read, bytes: read(), heard: Date.now() };
}

const secondsToATenth = (ms: number): number => Math.round(ms / 100) / 10;
/* failed: the addresses whose last direct try failed. */
/* trips: how long this machine's hellos to that one took, over the last day. */
type Kept = { target: DialTarget; session: Session | null; dialing: boolean; failed: Set<string>; directTriedAt: number; trips: RoundTrips };

const ignore = (): void => {};

/* One answer of the peer link's hello on a session, or a rejection when it does not come whole within ms. timed: told
   how long the answer's headers took from the request, which is the round trip to that machine. */
function askHello(h2: ClientHttp2Session, ms: number, timed?: (ms: number) => void): Promise<Hello> {
  return new Promise((resolve, reject) => {
    const from = performance.now();
    /* A session that ended since throws here, and the promise rejects with it. */
    const stream = h2.request({ ':method': 'GET', ':path': PEER_PATHS.hello });
    const chunks: Buffer[] = [];
    let status = 0;
    let size = 0;
    const giveUp = setTimeout(() => stream.close(), ms);
    stream.on('error', ignore);
    stream.once('response', headers => {
      status = Number(headers[':status']);
      if (status === 200) timed?.(performance.now() - from);
    });
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > HELLO_BYTES) stream.close();
    });
    stream.once('close', () => {
      clearTimeout(giveUp);
      try {
        if (status !== 200) throw new Error(`The peer link answered its hello with ${status}.`);
        resolve(HelloBody.parse(JSON.parse(Buffer.concat(chunks).toString())));
      } catch (err) {
        /* silent: the stream ended with no answer at all, which is how a machine hangs up on a peer it does not take. */
        reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { silent: status === 0 }));
      }
    });
    stream.end();
  });
}

/* A worker's sessions to the company's data machines: to each one its view lists it keeps one session open, directly at
   the machine's addresses when one answers, else through the relay, and it asks each who leads. Inside either path the
   two prove themselves by their certificates: the worker shows its own, and takes only a certificate of the company's
   authority, of a data machine, for the very machine it dialed, and not on its list of revoked ones. */
export class PeerSessions {
  private kept: Kept[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /* Since the last session, a data machine proved to be the one dialed and then hung up before its first answer. */
  private refused = false;

  constructor(private readonly opts: PeerSessionsOptions) {}

  /* The data machines to keep sessions to, from the last view. A machine no longer among them loses its session. */
  use(targets: DialTarget[]): void {
    if (this.closed) return;
    const before = this.kept;
    this.kept = targets.map(target => {
      const same = before.find(kept => kept.target.machine === target.machine);
      return same ? Object.assign(same, { target }) : { target, session: null, dialing: false, failed: new Set<string>(), directTriedAt: 0, trips: new RoundTrips() };
    });
    for (const gone of before.filter(kept => !this.kept.includes(kept))) this.end(gone, 'the machine is no longer among those this one keeps sessions to');
    this.timer ??= setInterval(() => this.look(), this.opts.everyMs ?? EVERY_MS).unref();
    this.look();
  }

  /* The first data machine, in the view's order, whose hello says it leads. */
  leader(): { machine: string; path: LinkPath; hello: Hello } | null {
    const kept = this.leading();
    return kept?.session ? { machine: kept.target.machine, path: kept.session.path, hello: kept.session.hello } : null;
  }

  /* The median round trip of a day's hellos to the machine that leads; null with no leader, or no hello answered yet. */
  linkRttMs(now = Date.now()): number | null {
    return this.leading()?.trips.median(now) ?? null;
  }

  /* The addresses the data machines saw this machine come from. */
  seen(): string[] {
    return [...new Set(this.kept.flatMap(kept => (kept.session ? [kept.session.hello.seen] : [])))];
  }

  /* path: how the leader is reached, else any data machine. directFails: the session goes through the relay though the
     data machine has an address on this machine's own network, which did not take the connection. refused: a data
     machine did not take this machine's certificate, and no session came since. */
  state(): { path: LinkPath | null; directFails: boolean; refused: boolean } {
    const kept = this.leading() ?? this.kept.find(one => one.session);
    const session = kept?.session;
    const own = this.opts.own();
    const directFails = session?.path === 'relay' && [...kept!.failed].some(address => own.some(mine => sameSubnet(address, mine)));
    return { path: session?.path ?? null, directFails, refused: this.refused };
  }

  /* A stream to the leader's app, as a connection to it: what is written reaches the app's door as bytes of HTTP. */
  connectApp(): Promise<Duplex> {
    const session = this.leading()?.session;
    if (!session) return Promise.reject(new Error(NO_LEADER));
    return new Promise((resolve, reject) => {
      /* A session that ended since throws here, and the promise rejects with it. */
      const stream = session.h2.request({ ':method': 'CONNECT', ':authority': APP_AUTHORITY });
      stream.on('error', ignore);
      stream.once('response', headers => {
        if (headers[':status'] === 200) return resolve(stream);
        stream.close();
        reject(new Error(`The leader did not open its app: ${String(headers[':status'])}.`));
      });
      stream.once('close', () => reject(new Error(NO_LEADER)));
    });
  }

  /* One request to a data machine's own keeper, on the session to it, by the id that keeper runs under: JSON both
     ways. None with no session to that machine, when no whole answer comes in time, and for an answer that is no
     JSON. */
  ask(networkId: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs = ASK_MS): Promise<{ status: number; body: unknown } | null> {
    const session = this.kept.find(kept => kept.target.networkId === networkId)?.session;
    if (!session) return Promise.resolve(null);
    return new Promise(resolve => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = session.h2.request({ ':method': method, ':path': path, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, { endStream: body === undefined });
      } catch {
        /* The session ended since. */
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let status = 0;
      let size = 0;
      const giveUp = setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), timeoutMs);
      stream.on('error', ignore);
      stream.once('response', headers => void (status = Number(headers[':status'])));
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > ASK_BYTES) stream.close(http2.constants.NGHTTP2_CANCEL);
      });
      stream.once('close', () => {
        clearTimeout(giveUp);
        try {
          resolve(status === 0 || size > ASK_BYTES ? null : { status, body: JSON.parse(Buffer.concat(chunks).toString()) as unknown });
        } catch {
          resolve(null);
        }
      });
      if (body !== undefined) stream.end(JSON.stringify(body));
    });
  }

  /* Whether a session to this data machine is open now. */
  reaches(machine: string): boolean {
    return Boolean(this.kept.find(kept => kept.target.machine === machine)?.session);
  }

  /* A stream to a data machine's database, as a connection to it: the leader's, or that of the machine named. Only a
     machine that keeps data is let through there. Nothing ends it for standing still: a database connection may. */
  connectDb(machine?: string): Promise<Duplex> {
    const session = machine === undefined ? this.leading()?.session : this.kept.find(kept => kept.target.machine === machine)?.session;
    if (!session) return Promise.reject(new Error(machine === undefined ? NO_LEADER : NO_SESSION));
    return new Promise((resolve, reject) => {
      /* A session that ended since throws here, and the promise rejects with it. */
      const stream = session.h2.request({ ':method': 'CONNECT', ':authority': DB_AUTHORITY });
      stream.on('error', ignore);
      stream.once('response', headers => {
        if (headers[':status'] === 200) return resolve(stream);
        stream.close();
        reject(new Error(`The machine did not open its database: ${String(headers[':status'])}.`));
      });
      stream.once('close', () => reject(new Error(NO_SESSION)));
    });
  }

  /* A stream of its own on the session to the leader's keeper, for what is too long to go as a request to the app: a
     bundle, asked for or sent. It is answered with the status as soon as the keeper gives one, also before a body that is
     being sent has ended; whoever asked reads the answer's body to its end or destroys it. A stream on which no byte
     moves for half a minute is cut, with an error for whoever reads it. length: how long the body is, said first where
     the keeper takes only what came whole. */
  stream(method: 'GET' | 'PUT', path: string, body?: Readable, length?: number): Promise<{ status: number; length: number | null; body: Readable }> {
    const session = this.leading()?.session;
    if (!session) return Promise.reject(new Error(NO_LEADER));
    return new Promise((resolve, reject) => {
      /* A session that ended since throws here, and the promise rejects with it. */
      const stream = session.h2.request({ ':method': method, ':path': path, ...(length === undefined ? {} : { 'content-length': length }) }, { endStream: !body });
      let answered = false;
      streamDeadline(stream, this.opts.streamIdleMs ?? STREAM_IDLE_MS, () => stream.destroy(new Error('The stream to the leader stopped moving.')), body);
      stream.on('error', err => void (answered || reject(err)));
      stream.once('response', headers => {
        answered = true;
        const length = headers['content-length'];
        resolve({ status: Number(headers[':status']), length: length === undefined ? null : Number(length), body: stream });
      });
      stream.once('close', () => {
        body?.destroy();
        if (!answered) reject(new Error(NO_LEADER));
      });
      if (!body) return;
      body.on('error', () => stream.close(http2.constants.NGHTTP2_CANCEL));
      body.pipe(stream);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const kept of this.kept.splice(0)) this.end(kept, 'this machine closed its sessions');
    return Promise.resolve();
  }

  private leading(): Kept | undefined {
    const best = highestLead(this.kept.flatMap(kept => (kept.session ? [{ kept, hello: kept.session.hello }] : [])));
    return best?.kept;
  }

  private end(kept: Kept, why: string): void {
    if (kept.session) this.cut(kept.session, why);
    kept.session = null;
  }

  /* Ends a session for a reason of this side, which its end says. */
  private cut(session: Session, why: string, gently = false): void {
    session.why ??= why;
    if (gently) session.h2.close();
    else session.h2.destroy();
  }

  /* A machine with no session is dialed; one reached through the relay gets its direct addresses tried again in time. */
  private look(): void {
    for (const kept of this.kept) {
      if (kept.dialing) continue;
      if (!kept.session) void this.dial(kept, true);
      else if (kept.session.path === 'relay' && Date.now() - kept.directTriedAt >= (this.opts.directEveryMs ?? DIRECT_EVERY_MS)) void this.dial(kept, false);
    }
  }

  private async dial(kept: Kept, relayToo: boolean): Promise<void> {
    kept.dialing = true;
    try {
      const session = (await this.dialDirect(kept)) ?? (relayToo ? await this.dialRelay(kept) : null);
      if (session) this.keep(kept, session);
    } finally {
      kept.dialing = false;
    }
  }

  /* Every address at once, and the first that answers wins: one that drops what it is sent would else hold the others,
     and the relay after them, up for its whole patience. Which of them failed is known once all have ended. */
  private dialDirect(kept: Kept): Promise<Session | null> {
    kept.directTriedAt = Date.now();
    const { addresses, peerPort } = kept.target;
    if (!peerPort || addresses.length === 0) return Promise.resolve(null);
    return new Promise(resolve => {
      const failed = new Set<string>();
      let left = addresses.length;
      let won = false;
      for (const address of addresses) {
        void this.open(kept.target, address, peerPort, 'direct').then(session => {
          left--;
          if (session && won) session.h2.destroy();
          else if (session) resolve(session);
          else failed.add(address);
          won ||= Boolean(session);
          if (left > 0) return;
          kept.failed = failed;
          if (!won) resolve(null);
        });
      }
    });
  }

  private dialRelay(kept: Kept): Promise<Session | null> {
    const { relayPort } = kept.target;
    return relayPort ? this.open(kept.target, LOOPBACK, relayPort, 'relay') : Promise.resolve(null);
  }

  /* Why this certificate is not the dialed machine's, or nothing when it is. */
  private notTheMachine(target: DialTarget, raw: Buffer): Error | undefined {
    try {
      const facts = certFacts(new X509Certificate(raw).toString());
      if (facts.machineId !== target.machine) return new Error('The certificate names another machine.');
      if (facts.role !== 'data') return new Error('The certificate is not of a machine that keeps data.');
      return this.opts.revoked().has(facts.serial) ? new Error('The certificate was revoked.') : undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /* A session that said hello, or null: nothing answered there in time, the machine there is not the one dialed, or it
     did not take this machine's certificate. With TLS 1.3 the handshake is through on this side before the data machine
     has looked at this machine's certificate, and a keeper that refuses one closes the connection with no word. So a
     session counts from its first hello, and a machine that showed the right certificate and then hung up with no
     answer to that hello is taken to have refused this one's. One that answered it, however oddly, has not. */
  private open(target: DialTarget, host: string, port: number, path: LinkPath): Promise<Session | null> {
    const held = this.opts.held();
    if (!held || this.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const socket = tls.connect({
        host,
        port,
        cert: held.certPem,
        key: this.opts.key.privatePem,
        ca: held.authorityPem,
        minVersion: 'TLSv1.3',
        ALPNProtocols: ['h2'],
        checkServerIdentity: (_name, cert) => this.notTheMachine(target, cert.raw),
      });
      let h2: ClientHttp2Session | undefined;
      let settled = false;
      const settle = (session: Session | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        if (!session) {
          h2?.destroy();
          socket.destroy();
        }
        resolve(session);
      };
      /* hungUp: the other side ended it, and not this side's patience. */
      const fail = (hungUp: boolean) => {
        if (hungUp && h2 && !settled) this.refuse();
        settle(null);
      };
      const giveUp = setTimeout(() => fail(false), this.opts.connectMs ?? CONNECT_MS);
      socket.on('error', () => fail(true));
      socket.once('close', () => fail(true));
      socket.once('secureConnect', () => {
        h2 = http2.connect(`https://${host}:${port}`, { createConnection: () => socket, settings: { initialWindowSize: WINDOW } });
        h2.on('error', ignore);
        const session = h2;
        askHello(session, this.opts.connectMs ?? CONNECT_MS).then(
          hello => settle(heldSession(session, path, hello, () => socket.bytesRead)),
          (err: { silent?: boolean }) => fail(err.silent === true),
        );
      });
    });
  }

  private refuse(): void {
    if (this.refused) return;
    this.refused = true;
    this.opts.log("A data machine of the company hung up before its first answer: it may not take this machine's certificate.");
    this.opts.changed?.();
  }

  private keep(kept: Kept, session: Session): void {
    if (this.closed || !this.kept.includes(kept) || session.h2.destroyed) return void session.h2.destroy();
    /* A direct session takes the place of the one through the relay, which ends once what it still carries has. */
    const before = kept.session;
    kept.session = session;
    if (before) {
      for (const timer of before.timers) clearInterval(timer);
      this.cut(before, `a ${session.path} session took its place`, true);
    }
    this.refused = false;
    session.h2.once('close', () => this.ended(kept, session));
    session.timers.push(...this.watch(kept, session));
    this.opts.changed?.();
  }

  /* What a kept session does in time: its hellos, its pings, and the looks for bytes that came on it. */
  private watch(kept: Kept, session: Session): NodeJS.Timeout[] {
    const silentMs = this.opts.silentMs ?? SILENT_MS;
    return [
      setInterval(() => this.hello(session, kept), this.opts.helloMs ?? HELLO_MS).unref(),
      setInterval(() => this.ping(session), this.opts.pingMs ?? PING_MS).unref(),
      setInterval(() => this.listen(session), Math.min(LISTEN_MS, silentMs)).unref(),
    ];
  }

  /* One line for every session that ended and why, but those this machine closes as it stops. */
  private ended(kept: Kept, session: Session): void {
    for (const timer of session.timers) clearInterval(timer);
    if (!this.closed || !session.why) this.opts.log(`The ${session.path} session to data machine ${kept.target.machine} ended: ${session.why ?? 'the other side or the network closed it'}.`);
    if (kept.session !== session) return;
    kept.session = null;
    this.opts.changed?.();
  }

  /* One hello at a time, each with the patience a connect gets: a busy machine answers late, and that is no reason to
     let go of it, nor is one that does not answer at all, as on a slow link its answer waits behind what the session
     carries. Only silence ends a session. */
  private hello(session: Session, kept: Kept): void {
    if (session.h2.destroyed || session.asking) return;
    session.asking = true;
    askHello(session.h2, this.opts.connectMs ?? CONNECT_MS, ms => kept.trips.add(ms, Date.now())).then(
      hello => {
        session.asking = false;
        const news = hello.lead !== session.hello.lead;
        session.hello = hello;
        if (news) this.opts.changed?.();
      },
      () => void (session.asking = false),
    );
  }

  /* One ping at a time asks for an answer, so that a session on which nothing else goes brings bytes while its link
     holds; an answer that comes late ends nothing. */
  private ping(session: Session): void {
    if (session.h2.destroyed || !session.pinged) return;
    session.pinged = !session.h2.ping(err => {
      if (!err) session.pinged = true;
    });
  }

  /* Bytes that came on the session since the last look keep it. Nothing for silentMs ends it: a machine that went away
     without a word sends none, and the session would else stay for as long as TCP waits. */
  private listen(session: Session): void {
    if (session.h2.destroyed) return;
    const bytes = session.read();
    const now = Date.now();
    const silentMs = this.opts.silentMs ?? SILENT_MS;
    if (bytes !== session.bytes) Object.assign(session, { bytes, heard: now });
    else if (now - session.heard >= silentMs) this.cut(session, `nothing came on it for ${secondsToATenth(silentMs)} s`);
  }
}
