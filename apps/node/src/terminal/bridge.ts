import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/* Hook calls are short; a picture for people is the biggest thing that passes. */
const MAX_BODY = 4 * 1024 * 1024;
/* A person's prompt waits this long for Hornhoof to open its turn. */
const HOOK_WAIT_MS = 10_000;

export type HookHandler = (agentKey: string, event: string, body: unknown) => Promise<void> | void;
export type AgentUrls = { mcpUrl: string; attachUrl: string; hookUrl: string };

const FORWARD = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];

/* Between an agent's long-lived program and Hornhoof, on 127.0.0.1 of the node: the program keeps one address for its tools
   and its hooks, and each call goes on with the token of the turn running now. The secret in the path tells agents apart. */
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

  constructor(
    private readonly hornhoof: string,
    private readonly onHook: HookHandler,
  ) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch(() => reply(res, 502, '')));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
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
     that person's turn: its calls between turns wait this long for a turn's token instead of failing at once. */
  waitForTurns(key: string, ms: number): void {
    if (ms > 0) this.patience.set(key, ms);
    else this.patience.delete(key);
  }

  private tokenFor(key: string): Promise<string | undefined> {
    const token = this.tokens.get(key);
    const ms = this.patience.get(key);
    if (token || !ms) return Promise.resolve(token);
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [, kind, secret, event] = (req.url ?? '').split('?')[0]!.split('/');
    const key = secret ? this.bySecret.get(secret) : undefined;
    if (!key || !kind) return reply(res, 404, '');
    const body = await readBody(req);
    if (kind === 'hook' && event) {
      let data: unknown = null;
      try {
        data = JSON.parse(body.toString('utf8') || 'null');
      } catch {
        /* A hook that sent no JSON still counts. */
      }
      await Promise.race([Promise.resolve(this.onHook(key, event, data)), new Promise(r => setTimeout(r, HOOK_WAIT_MS))]);
      return reply(res, 200, '');
    }
    if (kind !== 'mcp' && kind !== 'attach') return reply(res, 404, '');
    const token = kind === 'mcp' ? await this.tokenFor(key) : this.tokens.get(key);
    if (!token) return kind === 'mcp' ? noTurn(res, body) : reply(res, 409, JSON.stringify({ error: { message: 'No Hornhoof turn is running for this agent.' } }));
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    for (const h of FORWARD) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const target = `${this.hornhoof}${kind === 'mcp' ? '/mcp' : '/api/attachments'}`;
    const up = await fetch(target, { method: req.method, headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: new Uint8Array(body) }) });
    const out: Record<string, string> = {};
    for (const h of ['content-type', 'mcp-session-id']) {
      const v = up.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
    if (kind === 'mcp' && up.ok && asks(body, 'tools/list')) for (const heard of [...(this.listing.get(key) ?? [])]) heard();
  }
}

function reply(res: ServerResponse, status: number, body: string): void {
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

/* Whether a JSON-RPC message, or a batch of them, calls this method. */
function asks(body: Buffer, method: string): boolean {
  try {
    const msg = JSON.parse(body.toString('utf8'));
    return (Array.isArray(msg) ? msg : [msg]).some(m => m?.method === method);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
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
