import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { socketOf, type Capture, type Owns, type Peer } from './peer.js';
import { HookCalls } from './hook-calls.js';
import { HookFailures, type HookRejected } from './hook-failures.js';

/* Hook and tool calls are short; a file an agent puts on a task is the biggest thing that passes, up to Hornhoof's 50 MB. */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_FILE = 51 * 1024 * 1024;
/* A person's prompt waits this long for Hornhoof to open its turn. */
const HOOK_WAIT_MS = 10_000;

/* A hook's answer, if any, is text the program adds to what it got, as Claude Code and Kimi Code do with a prompt hook's. */
export type HookHandler = (agentKey: string, event: string, body: unknown) => Promise<string | void> | string | void;
export type AgentUrls = { mcpUrl: string; attachUrl: string; hookUrl: string };

const HOOKS = new Set(['start', 'prompt', 'invocation', 'queued', 'stop', 'status', 'tool', 'tooldone', 'toolfail', 'ask', 'interrupt', 'end']);
const FORWARD = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];

/* Between an agent's long-lived program and Hornhoof, on 127.0.0.1 of the node: the program keeps one address for its tools
   and its hooks, and each call goes on with the token of the turn running now. The secret in the path tells agents apart;
   the configured process check also proves that the call comes from that agent's own program. */
export class Bridge {
  private server: Server | null = null;
  private port = 0;
  private readonly bySecret = new Map<string, string>();
  private readonly secrets = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly listing = new Map<string, Set<() => void>>();
  /* How long an agent's tool calls between turns wait for a turn to open, and the calls waiting now. */
  private readonly patience = new Map<string, number>();
  private readonly waiting = new Map<string, Set<() => void>>();
  /* What the check found for each open connection and agent: a connection's process does not change. */
  private readonly checked = new WeakMap<Socket, Map<string, Promise<boolean>>>();

  private readonly accepted = new WeakMap<Socket, ReturnType<Capture>>();
  private readonly calls = new HookCalls();
  private readonly failures: HookFailures;

  constructor(
    private readonly hornhoof: string,
    private readonly onHook: HookHandler,
    private readonly owns: Owns | null = null,
    private readonly options: { proc?: string; capture?: Capture; rejected?: HookRejected } = {},
  ) { this.failures = new HookFailures(options.rejected); }

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch(() => this.failed(req, res)));
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
    if (token) this.tokens.set(key, token);
    else this.tokens.delete(key);
    if (token) for (const go of [...(this.waiting.get(key) ?? [])]) go();
  }

  /* Kimi Code connects to its tools when a person's first message starts its session, a moment before Hornhoof opens
     that person's turn: while it connects and lists them, it waits this long for a turn's token instead of failing at
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

  /* Resolves true once the agent's program has listed its tools through the bridge, or false after ms. A program
     connects to its tools on its own time after it starts, and Hornhoof answers only while a turn runs. */
  listed(key: string, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const waiting = this.listing.get(key) ?? new Set();
      this.listing.set(key, waiting);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        waiting.delete(heard);
        if (!waiting.size && this.listing.get(key) === waiting) this.listing.delete(key);
        resolve(ok);
      };
      const heard = () => done(true);
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
    const [path, query] = (req.url ?? '').split(/\?(.*)/s);
    const [, kind, secret, event] = path!.split('/');
    const key = secret ? this.bySecret.get(secret) : undefined;
    if (!key || !kind) return this.refused(req, res, 404, 'unknown bridge address');
    const peer = await this.peer(req);
    const owned = this.fromOwner(key, req.socket, peer);
    /* Under the picture address: pictures and files sent, and a task's file downloaded at /file. */
    if (kind === 'attach' && event !== undefined && event !== 'file') return reply(res, 404, '');
    /* Capture the inode first, then keep the bounded body while ancestry is checked. A completed body survives the
       caller closing its socket; it is never applied until ownership succeeds. */
    const reading = readBody(req, kind === 'attach' ? MAX_FILE : MAX_BODY);
    void reading.catch(() => {});
    if (!(await owned)) return this.refused(req, res, 403, 'owner check failed');
    const body = await reading;
    if (kind === 'hook') {
      if (!event) return this.refused(req, res, 404, 'unknown hook event');
      let data: unknown = null;
      try {
        data = JSON.parse(body.toString('utf8') || 'null');
      } catch {
        /* A hook that sent no JSON still counts. */
      }
      return this.hookCall(req, res, key, event, data);
    }
    if (kind !== 'mcp' && kind !== 'attach') return reply(res, 404, '');
    const token = kind === 'mcp' ? await this.tokenFor(key, req.method === 'GET' || only(body, CONNECTING)) : this.tokens.get(key);
    if (!token) return kind === 'mcp' ? noTurn(res, body) : reply(res, 409, JSON.stringify({ error: { message: 'No Hornhoof turn is running for this agent.' } }));
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const h of FORWARD) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const target = `${this.hornhoof}${kind === 'mcp' ? '/mcp' : `/api/attachments${event ? `/${event}` : ''}${query ? `?${query}` : ''}`}`;
    const up = await fetch(target, { method: req.method, headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: new Uint8Array(body) }) });
    const out: Record<string, string> = {};
    for (const h of ['content-type', 'mcp-session-id', 'x-file-name']) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
    if (kind === 'mcp' && up.ok && asks(body, 'tools/list')) for (const heard of [...(this.listing.get(key) ?? [])]) heard();
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

/* MCP clients take an HTTP error as a broken or signed-out server; a JSON-RPC error reaches the agent as words instead. */
function noTurn(res: ServerResponse, body: Buffer): void {
  let id: unknown = null;
  try {
    const msg = JSON.parse(body.toString('utf8'));
    id = msg?.id ?? null;
  } catch {
    /* Not JSON-RPC. */
  }
  if (id === null) return reply(res, 202, '');
  reply(res, 200, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: "No Hornhoof turn is running for this agent. Hornhoof's tools work during a turn." } }));
}

/* The messages an MCP client sends while it connects and looks at what the server has. */
const CONNECTING = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);

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

/* Whether a JSON-RPC message, or every message of a batch, calls one of these methods. */
function only(body: Buffer, methods: Set<string>): boolean {
  const all = messages(body);
  return all.length > 0 && all.every(m => typeof m?.method === 'string' && methods.has(m.method));
}

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
