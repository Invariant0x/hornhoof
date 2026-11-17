import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { privateToolCall, toolPrivacy, type ToolPrivacyPolicy } from '@hornhoof/protocol';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { socketOf, type Capture, type Owns, type Peer } from './peer.js';
import { serveCheckCommand } from '../check-command-runner.js';
import { HookCalls } from './hook-calls.js';
import { HookFailures, type HookRejected } from './hook-failures.js';
import { ToolsMemory } from './tools-memory.js';

/* Hook and tool calls are short. A file an agent sends or fetches passes as it comes, whatever its size. */
const MAX_BODY = 4 * 1024 * 1024;
/* A hook's answer waits this long for the host to give it. */
const HOOK_WAIT_MS = 10_000;
/* How long the bridge keeps a program's idle connection, as Hornhoof's front does: a program keeps it between two tool
   calls, and with Node's 5 seconds its next call on a connection the bridge was closing broke with ECONNRESET. */
const KEEP_ALIVE_MS = 72_000;

/* A hook's answer, if any, is text the program adds to what it got, as Claude Code and Kimi Code do with a prompt hook's. */
export type HookHandler = (agentKey: string, event: string, body: unknown) => Promise<string | void> | string | void;
export type AgentUrls = { mcpUrl: string; attachUrl: string; hookUrl: string };
/* Hornhoof's answer to what a program sent its tools with no turn running, as /mcp gave it; null when it cannot be asked. */
export type OutsideAnswer = { status: number; body: string };
/* Asks Hornhoof over the node's own link, with the protocol version the program asked with. */
export type Outside = (key: string, body: string, version: string | undefined) => Promise<OutsideAnswer | null>;
/* The step Hornhoof opened for a check command the agent's program runs with no turn running: signal stops the command when
   Hornhoof stops the step, and end says it ended, ok with code 0. Or the words the program gets for why it may not run. */
export type CheckStep = { jobId: string; signal: AbortSignal; end(ok: boolean): void } | { refused: string };
/* Asks Hornhoof for such a step over the node's own link; null when it cannot be asked. */
export type OpensCheck = (key: string) => Promise<CheckStep | null>;
/* The turn a person's words are opening for the agent now, which a tool call waits for; null when none is. */
export type Opening = (key: string) => Promise<unknown> | null;

/* A short outage of Hornhoof, as its proxy says it: a call that only reads is asked again after these growing pauses. */
const OUTAGE = new Set([502, 503, 504]);
const OUTAGE_PAUSES_MS = [1_000, 2_000, 4_000];
/* Tools that change nothing, so asking one again cannot do anything twice. */
const READS = new Set(['task', 'tasks', 'test_run', 'work_run', 'briefing', 'company']);

const HOOKS = new Set(['start', 'prompt', 'invocation', 'queued', 'stop', 'status', 'tool', 'tooldone', 'toolfail', 'ask', 'interrupt', 'end']);
const FORWARD = ['content-type', 'content-length', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];

/* Between an agent's long-lived program and Hornhoof, on 127.0.0.1 of the node: the program keeps one address for its tools
   and its hooks, and each call goes on with the token of the turn running now. The secret in the path tells agents apart;
   the configured process check also proves that the call comes from that agent's own program. */
export class Bridge {
  private server: Server | null = null;
  private port = 0;
  private readonly bySecret = new Map<string, string>();
  private readonly secrets = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly listing = new Map<string, Set<(asked: number) => void>>();
  /* When each agent's program last asked for the list of its tools that the bridge then handed it. */
  private readonly listedAt = new Map<string, number>();
  /* When each agent's program last connected to its tools and was turned away, as no turn ran and the node knew no answer
     for Hornhoof: it does not try again, and keeps no tools for the rest of its session. */
  private readonly refusedAt = new Map<string, number>();
  /* How long an agent's tool calls between turns wait for a turn to open, and the calls waiting now. */
  private readonly patience = new Map<string, number>();
  private readonly waiting = new Map<string, Set<() => void>>();
  /* What the check found for each open connection and agent: a connection's process does not change. */
  private readonly checked = new WeakMap<Socket, Map<string, Promise<boolean>>>();

  private readonly accepted = new WeakMap<Socket, ReturnType<Capture>>();
  private readonly calls = new HookCalls();
  private readonly checkStops = new Map<string, Set<AbortController>>();
  /* Check commands that run in a step of their own, with no turn: a turn's token does not stop them. */
  private readonly stepStops = new Map<string, Set<AbortController>>();
  private readonly failures: HookFailures;
  /* The calls to Hornhoof's tools turned away for want of a turn, said once a minute for each agent and method. */
  private readonly refusals: HookFailures;
  private readonly memory = new ToolsMemory();
  private readonly policies = new Map<string, Map<string, ToolPrivacyPolicy>>();

  constructor(
    private readonly hornhoof: string,
    private readonly onHook: HookHandler,
    private readonly owns: Owns | null = null,
    private readonly options: { proc?: string; capture?: Capture; rejected?: HookRejected; unowned?: (key: string, event: string) => void; refused?: HookRejected; pause?: (ms: number) => Promise<void>; outside?: Outside; opening?: Opening; checkStep?: OpensCheck; sensitive?: (key: string, name: string, input: unknown, answer?: unknown, policy?: ToolPrivacyPolicy) => void } = {},
  ) {
    this.failures = new HookFailures(options.rejected);
    this.refusals = new HookFailures(options.refused);
  }

  async start(): Promise<void> {
    const server = createServer({ keepAliveTimeout: KEEP_ALIVE_MS }, (req, res) => void this.handle(req, res).catch(() => this.failed(req, res)));
    server.on('connection', socket => {
      if (this.owns) this.accepted.set(socket, this.capture({ port: socket.remotePort ?? 0, bridgePort: socket.localPort ?? 0 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  private capture(peer: Peer): ReturnType<Capture> {
    return this.options.capture ? this.options.capture(peer) : socketOf(this.options.proc ?? '/proc', peer).then(acceptedInode => ({ acceptedInode }));
  }

  stop(): void {
    this.abortChecks();
    this.server?.close();
    this.server = null;
  }

  agent(key: string): AgentUrls {
    let secret = this.secrets.get(key);
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      this.secrets.set(key, secret);
      this.bySecret.set(secret, key);
    }
    const base = `http://127.0.0.1:${this.port}`;
    return { mcpUrl: `${base}/mcp/${secret}`, attachUrl: `${base}/attach/${secret}`, hookUrl: `${base}/hook/${secret}` };
  }

  /* The token of the agent's running turn, or null between turns. */
  setToken(key: string, token: string | null): void {
    this.changeCheckToken(key, token);
    if (token) this.tokens.set(key, token);
    else this.tokens.delete(key);
    if (token) for (const go of [...(this.waiting.get(key) ?? [])]) go();
  }

  /* A program may connect to its tools a moment before Hornhoof opens a turn, as Kimi Code does when a person's first message
     starts its session: while it connects and lists them, it waits this long for a turn's token instead of failing at
     once. A tool call never waits, or it would run under the next turn. */
  waitForTurns(key: string, ms: number): void {
    if (ms > 0) this.patience.set(key, ms);
    else this.patience.delete(key);
  }

  private tokenFor(key: string, connecting: boolean): Promise<string | undefined> {
    const token = this.tokens.get(key);
    const ms = this.patience.get(key);
    if (token || !ms || !connecting) return Promise.resolve(token);
    return new Promise(resolve => {
      const waiters = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size && this.waiting.get(key) === waiters) this.waiting.delete(key);
        resolve(this.tokens.get(key));
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  /* Whether the agent's program has listed its tools through the bridge, asking for them since then. */
  listedSince(key: string, since: number): boolean {
    return (this.listedAt.get(key) ?? -Infinity) >= since;
  }

  /* Whether the agent's program was turned away as it connected to its tools since then, and has not listed them since. */
  toolsRefusedSince(key: string, since: number): boolean {
    const refused = this.refusedAt.get(key) ?? -Infinity;
    return refused >= since && !this.listedSince(key, refused);
  }

  /* Resolves true once the agent's program has listed its tools through the bridge, asking for them since the time given
     (from now on by default), at once if it did, or false after ms. A program connects to its tools on its own time
     after it starts, and Hornhoof answers only while a turn runs. */
  listed(key: string, ms: number, since = Date.now()): Promise<boolean> {
    if (this.listedSince(key, since)) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiting = this.listing.get(key) ?? new Set();
      this.listing.set(key, waiting);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        waiting.delete(heard);
        if (!waiting.size && this.listing.get(key) === waiting) this.listing.delete(key);
        resolve(ok);
      };
      const heard = (asked: number) => asked >= since && done(true);
      const timer = setTimeout(() => done(false), ms);
      waiting.add(heard);
    });
  }

  private fromOwner(key: string, socket: Socket, peer: Peer): Promise<boolean> {
    if (!this.owns) return Promise.resolve(true);
    const known = this.checked.get(socket) ?? new Map<string, Promise<boolean>>();
    this.checked.set(socket, known);
    const hint = `${key}:${peer.pid ?? 'legacy'}`;
    let found = known.get(hint);
    if (!found) {
      found = this.owns(key, peer).catch(() => false);
      known.set(hint, found);
    }
    return found;
  }

  private async peer(req: IncomingMessage): Promise<Peer> {
    const peer: Peer = { port: req.socket.remotePort ?? 0, bridgePort: this.port };
    const hint = req.headers['x-hh-pid'];
    if (hint !== undefined) peer.pid = typeof hint === 'string' && /^[1-9][0-9]{0,9}$/.test(hint) ? Number(hint) : 0;
    if (this.owns) Object.assign(peer, await (this.accepted.get(req.socket) ?? this.capture(peer)));
    return peer;
  }

  private refused(req: IncomingMessage, res: ServerResponse, status: number, reason: string): void {
    const [, kind, secret, rawEvent] = (req.url ?? '').split('?')[0]!.split('/');
    if (kind === 'hook') this.failures.reject(this.bySecret.get(secret ?? '') ?? null, HOOKS.has(rawEvent ?? '') ? rawEvent! : 'unknown', reason);
    reply(res, status, '');
  }

  private failed(req: IncomingMessage, res: ServerResponse): void {
    this.refused(req, res, 502, 'request failed');
  }

  private async hookAnswer(key: string, event: string, data: unknown): Promise<string> {
    const answer = await Promise.race([Promise.resolve(this.onHook(key, event, data)), new Promise<void>(r => setTimeout(r, HOOK_WAIT_MS))]);
    return typeof answer === 'string' ? answer : '';
  }

  private async hookCall(req: IncomingMessage, res: ServerResponse, key: string, event: string, data: unknown): Promise<void> {
    if (!HOOKS.has(event)) return this.refused(req, res, 404, 'unknown hook event');
    const id = req.headers['x-hh-call'];
    if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id))) return this.refused(req, res, 400, 'invalid hook call id');
    const answer = await this.calls.run(key, event, id, () => this.hookAnswer(key, event, data));
    if (answer.status !== 200) return this.refused(req, res, answer.status, hookFailure(answer.status));
    reply(res, answer.status, answer.text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const asked = Date.now();
    const [path, query] = (req.url ?? '').split(/\?(.*)/s);
    const [, kind, secret, event] = path!.split('/');
    const key = secret ? this.bySecret.get(secret) : undefined;
    if (!key || !kind) return this.refused(req, res, 404, 'unknown bridge address');
    const peer = await this.peer(req);
    const owned = this.fromOwner(key, req.socket, peer);
    /* Under the picture address: pictures and files sent, and a task's file downloaded at /file. */
    if (!attachmentPath(kind, event)) return reply(res, 404, '');
    /* Capture the inode first, then keep the bounded body while ancestry is checked. A completed body survives the
       caller closing its socket; it is never applied until ownership succeeds. A file is not kept: it waits unread until
       then, and goes on to Hornhoof as it comes. */
    const reading = kind === 'attach' ? null : readBody(req, MAX_BODY);
    void reading?.catch(() => {});
    if (!(await owned)) {
      if (kind === 'hook' && event) this.options.unowned?.(key, event);
      return this.refused(req, res, 403, 'owner check failed');
    }
    const body = reading ? await reading : Buffer.alloc(0);
    this.observeSensitive(key, kind, body);
    /* Only the bridge asks for upload permissions; never hand one back to the program as an MCP response. */
    if (kind === 'mcp' && asks(body, 'attachments/token')) return reply(res, 403, '');
    if (agentCall(kind)) return this.agentCall(req, res, key, kind, event, body);
    if (kind !== 'mcp' && kind !== 'attach') return reply(res, 404, '');
    if (kind === 'mcp' && req.method === 'POST' && !this.tokens.has(key) && (await this.withoutTurn(req, res, key, body, asked))) return;
    const known = kind === 'mcp' && !this.tokens.has(key) ? this.memory.answer(key, body) : null;
    if (known !== null) return this.answered(res, key, body, known, asked);
    const token = kind === 'mcp' ? await this.tokenFor(key, req.method === 'GET' || only(body, CONNECTING)) : await this.attachmentTokenFor(key, req.method, event);
    if (!token) return kind === 'mcp' ? this.noTools(res, key, body, asked) : reply(res, 409, JSON.stringify({ error: { message: 'No Hornhoof turn is running for this agent.' } }));
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const h of FORWARD) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const target = `${this.hornhoof}${kind === 'mcp' ? '/mcp' : `/api/attachments${event ? `/${event}` : ''}${query ? `?${query}` : ''}`}`;
    const sent = req.method === 'GET' || req.method === 'HEAD' ? {} : kind === 'attach' ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : { body: new Uint8Array(body) };
    const up = await this.forward(target, { method: req.method, headers, ...sent } as RequestInit, onlyReading(kind, req.method, body));
    const out: Record<string, string> = {};
    for (const h of ['content-type', 'mcp-session-id', 'x-file-name']) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    if (kind === 'attach') return pipeline(up.body ? Readable.fromWeb(up.body as never) : Readable.from([]), res);
    const answer = Buffer.from(await up.arrayBuffer());
    this.observeSensitive(key, kind, body, answer);
    if (kind === 'mcp' && up.ok) this.keepTools(key, body, answer);
    res.end(answer);
    if (kind === 'mcp' && up.ok && asks(body, 'tools/list')) this.heardList(key, asked);
  }

  private attachmentTokenFor(key: string, method: string | undefined, event: string | undefined): Promise<string | undefined> {
    const token = this.tokens.get(key);
    if (token || method !== 'POST' || event !== undefined) return Promise.resolve(token);
    return this.attachmentToken(key);
  }

  /* The program may still work after the host lost its turn token. Ask on the same authenticated node link as MCP,
     without opening a turn: the server grants only a file upload to that agent's existing running task turn. Never
     keep this permission as a tool token or across requests. */
  private async attachmentToken(key: string): Promise<string | undefined> {
    const answer = await this.options.outside?.(key, JSON.stringify({ jsonrpc: '2.0', id: 'attachment', method: 'attachments/token' }), undefined);
    if (answer?.status !== 200) return undefined;
    try {
      const value = JSON.parse(answer.body) as { result?: { token?: unknown } };
      return typeof value.result?.token === 'string' ? value.result.token : undefined;
    } catch { return undefined; }
  }

  /* A call that only reads goes again after a short outage, a few times with growing pauses; a write is never sent twice,
     as it may have gone through. An outage that lasts reaches the program as it came. */
  private async forward(target: string, init: RequestInit, reads: boolean): Promise<Response> {
    let up = await fetch(target, init);
    for (const ms of reads ? OUTAGE_PAUSES_MS : []) {
      if (!OUTAGE.has(up.status)) break;
      await up.body?.cancel();
      await (this.options.pause ?? pause)(ms);
      up = await fetch(target, init);
    }
    return up;
  }

  /* With no turn running, Hornhoof answers over the node's link as /mcp does in a turn: what the program sends as it connects
     at once, and a tool call after the turn a person's words are opening now, if one is, goes with that turn's token.
     False when the request goes on as before: a turn's token came, or Hornhoof cannot be asked. */
  private async withoutTurn(req: IncomingMessage, res: ServerResponse, key: string, body: Buffer, asked: number): Promise<boolean> {
    const outside = this.options.outside;
    if (!outside) return false;
    const opening = only(body, CONNECTING) ? null : (this.options.opening?.(key) ?? null);
    if (opening) {
      await opening.catch(() => {});
      if (this.tokens.has(key)) return false;
    }
    const version = req.headers['mcp-protocol-version'];
    const got = await outside(key, body.toString('utf8'), typeof version === 'string' ? version : undefined).catch(() => null);
    if (!got) return false;
    const answer = Buffer.from(got.body);
    this.observeSensitive(key, 'mcp', body, answer);
    reply(res, got.status, got.body);
    /* Turned away as it connects, by the machine installing its build or the agent no longer here: it keeps no tools. */
    if (got.status !== 200 || !resultsOnly(answer)) {
      if (JOINING.some(method => asks(body, method))) this.refusedAt.set(key, asked);
      return true;
    }
    this.keepTools(key, body, answer);
    if (asks(body, 'tools/list')) this.heardList(key, asked);
    return true;
  }

  /* With no turn open, a program that connects or lists its tools hears what Hornhoof said to the same before. */
  private answered(res: ServerResponse, key: string, body: Buffer, known: string, asked: number): void {
    reply(res, known ? 200 : 202, known);
    if (asks(body, 'tools/list')) this.heardList(key, asked);
  }

  toolPolicy(key: string, name: string): ToolPrivacyPolicy | undefined {
    for (const [registered, policy] of this.policies.get(key) ?? []) {
      if (name === registered || name.endsWith(`__${registered}`) || name.endsWith(`.${registered}`)) return policy;
    }
    return toolPrivacy(name);
  }

  private observeSensitive(key: string, kind: string, body: Buffer, answer?: Buffer): void {
    if (kind !== 'mcp') return;
    try {
      const call = observedCall(body);
      if (!call) return;
      const target = privateToolCall(call.name, call.input, name => this.toolPolicy(key, name));
      if (target.policy?.sensitive) this.options.sensitive?.(key, target.name, target.input, answer ? JSON.parse(answer.toString('utf8')) : undefined, target.policy);
    } catch { /* Raw data belongs to the caller even when it cannot be parsed. */ }
  }

  private keepTools(key: string, body: Buffer, answer: Buffer): void {
    this.memory.keep(key, body, answer);
    if (!asks(body, 'tools/list')) return;
    try {
      const result = JSON.parse(answer.toString('utf8')) as { result?: { tools?: { name?: unknown; _meta?: ToolPrivacyPolicy }[] } };
      const policies = this.policies.get(key) ?? new Map<string, ToolPrivacyPolicy>();
      for (const tool of result.result?.tools ?? []) if (privatePolicy(tool)) policies.set(tool.name, tool._meta);
      this.policies.set(key, policies);
    } catch { /* A malformed listing supplies no new privacy policies. */ }
  }

  /* A call the node cannot answer for Hornhoof with no turn open: a tool call gets words the agent reads, and a program
     turned away as it connects keeps no tools until it starts again. Each refusal goes to the node's log. */
  private noTools(res: ServerResponse, key: string, body: Buffer, asked: number): void {
    if (JOINING.some(method => asks(body, method))) this.refusedAt.set(key, asked);
    if (noTurn(res, body)) this.refusals.reject(key, messages(body).map(m => String(m?.method)).join(', '), 'no Hornhoof turn is running');
  }

  private changeCheckToken(key: string, token: string | null): void {
    if (this.tokens.get(key) !== token) this.abortChecks(key);
  }

  private abortChecks(key?: string): void {
    const groups = key === undefined ? [...this.checkStops.values(), ...this.stepStops.values()] : [this.checkStops.get(key) ?? new Set<AbortController>()];
    for (const stops of groups) for (const stop of stops) stop.abort();
  }

  private async agentCall(req: IncomingMessage, res: ServerResponse, key: string, kind: 'hook' | 'check', event: string | undefined, body: Buffer): Promise<void> {
    if (kind === 'check') return this.checkCommand(key, body, res);
    if (!event) return this.refused(req, res, 404, 'unknown hook event');
    let data: unknown = null;
    try { data = JSON.parse(body.toString('utf8') || 'null'); } catch { /* An empty hook still counts. */ }
    return this.hookCall(req, res, key, event, data);
  }

  /* A check command runs in the agent's turn, or with none in a step Hornhoof opens for it as for a tool call. */
  private async checkCommand(key: string, body: Buffer, res: ServerResponse): Promise<void> {
    if (this.tokens.has(key)) return void (await this.runCheck(key, body, res, this.checkStops));
    const step = (await this.options.checkStep?.(key)) ?? null;
    if (!step) return reply(res, 409, 'No Hornhoof turn is running for this agent.');
    if ('refused' in step) return reply(res, 409, step.refused);
    let ok = false;
    try { ok = await this.runCheck(key, body, res, this.stepStops, step); }
    finally { step.end(ok); }
  }

  /* It stops when its program goes, and as its turn's token changes or as Hornhoof stops its step. True when it ran to
     its end with code 0. */
  private async runCheck(key: string, body: Buffer, res: ServerResponse, groups: Map<string, Set<AbortController>>, step?: { jobId: string; signal: AbortSignal }): Promise<boolean> {
    const stop = new AbortController(), stops = groups.get(key) ?? new Set<AbortController>();
    groups.set(key, stops); stops.add(stop);
    const closed = () => stop.abort(); res.once('close', closed);
    step?.signal.addEventListener('abort', closed, { once: true });
    if (step?.signal.aborted) stop.abort();
    try { return await serveCheckCommand(key, body, stop.signal, res, step?.jobId); }
    finally { res.removeListener('close', closed); step?.signal.removeEventListener('abort', closed); stops.delete(stop); }
  }

  /* A slow answer to a request from before counts from when it was asked. */
  private heardList(key: string, asked: number): void {
    if (!this.listedSince(key, asked)) this.listedAt.set(key, asked);
    for (const heard of [...(this.listing.get(key) ?? [])]) heard(asked);
  }
}

function reply(res: ServerResponse, status: number, body: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/* MCP clients take an HTTP error as a broken or signed-out server; a JSON-RPC error reaches the agent as words instead.
   Whether it refused a request, which a notification is not. */
function noTurn(res: ServerResponse, body: Buffer): boolean {
  let id: unknown = null;
  try {
    const msg = JSON.parse(body.toString('utf8'));
    id = msg?.id ?? null;
  } catch {
    /* Not JSON-RPC. */
  }
  if (id === null) {
    reply(res, 202, '');
    return false;
  }
  reply(res, 200, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: "No Hornhoof turn is running for this agent. Hornhoof's tools work during a turn." } }));
  return true;
}

/* The messages an MCP client sends while it connects and looks at what the server has. A newer client, agy 1.4.12 among
   them, first asks with server/discover and falls back to initialize when the server does not know it. */
const CONNECTING = new Set(['server/discover', 'initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
/* The ones a client that is turned away at them keeps no tools after. */
const JOINING = ['server/discover', 'initialize', 'tools/list'];

function messages(body: Buffer): { method?: unknown }[] {
  try {
    const msg = JSON.parse(body.toString('utf8'));
    return Array.isArray(msg) ? msg : [msg];
  } catch {
    return [];
  }
}

/* Whether a JSON-RPC message, or a batch of them, calls this method. */
function asks(body: Buffer, method: string): boolean {
  return messages(body).some(m => m?.method === method);
}

/* Whether a JSON-RPC answer, or every answer of a batch, is a result and no error. */
function resultsOnly(answer: Buffer): boolean {
  const all = messages(answer) as { result?: unknown }[];
  return all.length > 0 && all.every(m => m?.result !== undefined);
}

/* Whether a JSON-RPC message, or every message of a batch, calls one of these methods. */
function only(body: Buffer, methods: Set<string>): boolean {
  const all = messages(body);
  return all.length > 0 && all.every(m => typeof m?.method === 'string' && methods.has(m.method));
}

/* Whether a call only reads: a task's file asked for, or a JSON-RPC message, or every message of a batch, that calls a tool
   that only reads. */
function onlyReading(kind: string, method: string | undefined, body: Buffer): boolean {
  if (kind === 'attach') return method === 'GET';
  const all = messages(body) as { method?: unknown; params?: { name?: unknown } }[];
  return all.length > 0 && all.every(m => m?.method === 'tools/call' && typeof m.params?.name === 'string' && READS.has(m.params.name));
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too big'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hookFailure(status: number): string {
  if (status === 409) return 'hook call id reused for another event';
  if (status === 429) return 'too many recent hook calls';
  return 'hook handler failed';
}

const agentCall = (kind: string): kind is 'hook' | 'check' => kind === 'hook' || kind === 'check';
const attachmentPath = (kind: string, event: string | undefined): boolean => kind !== 'attach' || event === undefined || event === 'file';

function observedCall(body: Buffer): { name: string; input: unknown } | null {
  const call = JSON.parse(body.toString('utf8')) as { method?: string; params?: { name?: string; arguments?: unknown } };
  const name = call.params?.name;
  return call.method === 'tools/call' && typeof name === 'string' ? { name, input: call.params?.arguments } : null;
}

function privatePolicy(tool: { name?: unknown; _meta?: ToolPrivacyPolicy }): tool is { name: string; _meta: ToolPrivacyPolicy } {
  return typeof tool.name === 'string' && (tool._meta?.sensitive === true || tool._meta?.delegatesTool === true);
}
