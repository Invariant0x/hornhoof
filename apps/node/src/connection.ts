import { ACKS_HEADER, cut, TOOLS_HEADER, parseServerMessage, type NodeDisconnectCause, type NodeReconnect } from '@hornhoof/protocol';
import { OperatorDeliveryMetadata, OperatorServerMessage, type ProgramNodeMessage, type ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';
import { nodeLog } from './node-log.js';

export function parseOperatorServerMessage(raw: string): ProgramServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    const operator = OperatorServerMessage.safeParse(value);
    if (operator.success) return operator.data;
    const base = parseServerMessage(raw);
    if (base?.type !== 'job.run' && base?.type !== 'agent.say') return base;
    const metadata = OperatorDeliveryMetadata.safeParse(value);
    return metadata.success ? { ...base, ...metadata.data } : null;
  } catch { return null; }
}

export const DEFAULT_BACKOFF = { firstMs: 1_000, maxMs: 30_000 } as const;
/* Bidirectional frames every 15 s keep home NAT mappings (30-60 s idle expiry) warm; 35 s silence catches two missed pings
   plus one missed 20 s server ping so the node terminates and reconnects well under 60 s. */
export const DEFAULT_PING_MS = 15_000;
export const DEFAULT_SILENCE_MS = 35_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_KEEP_ALIVE_MS = 15_000;
export const DEFAULT_CLOCK_JUMP_MS = 15_000;

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA', 'ESERVFAIL']);

type ConnectOptions = {
  url: string;
  key: string;
  log?(line: string): void;
  /* acks: the server says in its upgrade answer that it confirms numbered messages; tools: that it answers agents' tools
     with no turn running. */
  onOpen(send: (m: ProgramNodeMessage) => boolean, acks: boolean, tools: boolean): void;
  onMessage(m: ProgramServerMessage): void;
  onClose?(): void;
  /* Hornhoof does not know this key any more: the machine was disconnected there. */
  onRefused?(): void;
  backoff?: { firstMs: number; maxMs: number };
  pingMs?: number;
  silenceMs?: number;
  handshakeTimeoutMs?: number;
  keepAliveMs?: number;
  clockJumpMs?: number;
  monitorMs?: number;
  probeMs?: number;
  now?: () => number;
  random?: () => number;
  addresses?: () => string;
  lookup?: LookupFunction;
  scheduleRetry?: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  createSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
};

type Attempt = {
  startedAt: number;
  opened: boolean;
  healthyOpen: boolean;
  watchdog: boolean;
  handshakeTimedOut: boolean;
  /* The server's upgrade answer said it confirms numbered messages, and that it answers agents' tools with no turn. */
  acks: boolean;
  tools: boolean;
  errorCause: NodeDisconnectCause | null;
  errorCode: string | null;
  error: string | null;
  dnsFailed: boolean;
};

type ActiveSocket = {
  ws: WebSocket;
  attempt: Attempt;
};

type Outage = {
  disconnectedMs: number;
  disconnectedAt: string;
  attempts: number;
  cause: NodeDisconnectCause;
  closeCode: number | null;
  closeReason: string | null;
  errorCode: string | null;
  error: string | null;
  dnsFailed: boolean;
  watchdogTimedOut: boolean;
  clockJumpMs: number;
  networkChanged: boolean;
};

type Timings = {
  firstMs: number;
  maxMs: number;
  pingMs: number;
  silenceMs: number;
  handshakeTimeoutMs: number;
  keepAliveMs: number;
  clockJumpMs: number;
  monitorMs: number;
  probeWindowMs: number;
};

type Hooks = {
  now: () => number;
  random: () => number;
  readAddresses: () => string;
  scheduleRetry: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  createSocket: (url: string, options: WebSocket.ClientOptions) => WebSocket;
};

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const nonEmpty = (text: string): string | null => text || null;

function cleanSingleLine(raw: string, key: string, max: number): string {
  return cut(nodeLog(raw, [key]).replace(/\s+/g, ' ').trim(), max);
}

function safeCall(fn: () => void, onError?: (err: unknown) => void): void {
  try {
    fn();
  } catch (err) {
    onError?.(err);
  }
}

export function networkSnapshot(readInterfaces: typeof networkInterfaces = networkInterfaces): string {
  try {
    const entries: string[] = [];
    for (const [name, list = []] of Object.entries(readInterfaces())) {
      for (const info of list) {
        if (!info.internal) entries.push(`${name}:${info.address}`);
      }
    }
    return entries.sort().join(',');
  } catch {
    return '';
  }
}

export function jitteredDelay(cap: number, firstMs: number, maxMs: number, random: () => number): number {
  const floor = Math.min(firstMs, maxMs);
  const low = Math.max(floor, Math.floor(cap * 0.75));
  const high = Math.min(maxMs, Math.max(low, Math.ceil(cap * 1.25)));
  return low + Math.floor(random() * (high - low + 1));
}

function errorCodeOf(err: Error & { code?: unknown }): string | null {
  const http = /\bUnexpected server response: (\d{3})\b/.exec(err.message);
  if (http) return `HTTP_${http[1]}`;
  if (typeof err.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(err.code)) return err.code;
  return null;
}

function causeFromError(code: string | null, message: string): NodeDisconnectCause {
  if (code !== null && code.startsWith('HTTP_')) return 'http_rejected';
  if (code !== null && DNS_CODES.has(code)) return 'dns_error';
  if (/handshake has timed out/i.test(message)) return 'handshake_timeout';
  return 'socket_error';
}

function causeFromClose(code: number, attempt: Attempt): NodeDisconnectCause {
  if (attempt.watchdog) return 'watchdog_timeout';
  if (attempt.handshakeTimedOut) return 'handshake_timeout';
  if (attempt.errorCause) return attempt.errorCause;
  return code === 1006 ? 'abnormal_close' : 'server_close';
}

function agentForLookup(url: string, lookup: LookupFunction | undefined): HttpAgent | undefined {
  if (!lookup) return undefined;
  return url.startsWith('wss:') ? new HttpsAgent({ lookup }) : new HttpAgent({ lookup });
}

function startOutage(
  atMs: number,
  attempts: number,
  cause: NodeDisconnectCause,
  code: number | null,
  reason: string | null,
  attempt: Attempt,
  jumpMs: number,
  netChanged: boolean,
): Outage {
  return {
    disconnectedMs: atMs,
    disconnectedAt: new Date(atMs).toISOString(),
    attempts,
    cause,
    closeCode: code,
    closeReason: reason,
    errorCode: attempt.errorCode,
    error: attempt.error,
    dnsFailed: attempt.dnsFailed,
    watchdogTimedOut: attempt.watchdog,
    clockJumpMs: jumpMs,
    networkChanged: netChanged,
  };
}

function mergeFailedRetry(outage: Outage, attempt: Attempt, jumpMs: number, netChanged: boolean): Outage {
  return {
    ...outage,
    attempts: outage.attempts + 1,
    errorCode: outage.errorCode || attempt.errorCode,
    error: outage.error || attempt.error,
    dnsFailed: outage.dnsFailed || attempt.dnsFailed,
    watchdogTimedOut: outage.watchdogTimedOut || attempt.watchdog,
    clockJumpMs: Math.max(outage.clockJumpMs, jumpMs),
    networkChanged: outage.networkChanged || netChanged,
  };
}

function finishReconnect(outage: Outage, reconnectedMs: number, jumpMs: number, netChanged: boolean): NodeReconnect {
  const bestJump = Math.max(outage.clockJumpMs, jumpMs);
  return {
    disconnectedAt: outage.disconnectedAt,
    reconnectedAt: new Date(reconnectedMs).toISOString(),
    offlineMs: Math.max(0, reconnectedMs - outage.disconnectedMs),
    attempts: outage.attempts + 1,
    cause: outage.cause,
    closeCode: outage.closeCode,
    closeReason: outage.closeReason,
    errorCode: outage.errorCode,
    error: outage.error,
    dnsFailed: outage.dnsFailed,
    watchdogTimedOut: outage.watchdogTimedOut,
    clockJumpMs: bestJump || null,
    networkChanged: outage.networkChanged || netChanged,
  };
}

function connectLogLine(report: NodeReconnect | null): string {
  if (!report) return 'Connected to Hornhoof.';
  const word = report.attempts === 1 ? 'attempt' : 'attempts';
  return `Connected to Hornhoof after ${report.attempts} ${word} (offline ${report.offlineMs} ms, cause: ${report.cause}).`;
}

function disconnectLogLine(cause: NodeDisconnectCause, code: number | null, detail: string | null): string {
  const codePart = code === null ? '' : `, code ${code}`;
  const detailPart = detail ? `: ${detail}` : '';
  return `Connection closed (${cause}${codePart})${detailPart}.`;
}

const newAttempt = (startedAt: number): Attempt => ({
  startedAt,
  opened: false,
  healthyOpen: false,
  watchdog: false,
  handshakeTimedOut: false,
  acks: false,
  tools: false,
  errorCause: null,
  errorCode: null,
  error: null,
  dnsFailed: false,
});

const defaultMonitorMs = (pingMs: number): number => Math.min(5_000, Math.max(15, Math.floor(pingMs / 3)));

const defaultProbeMs = (silenceMs: number): number => Math.min(3_000, Math.max(25, Math.ceil(silenceMs / 10)));

function baseTimings({
  backoff = DEFAULT_BACKOFF,
  pingMs = DEFAULT_PING_MS,
  silenceMs = DEFAULT_SILENCE_MS,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
}: ConnectOptions): Omit<Timings, 'monitorMs' | 'probeWindowMs' | 'keepAliveMs' | 'clockJumpMs'> {
  return { firstMs: backoff.firstMs, maxMs: backoff.maxMs, pingMs, silenceMs, handshakeTimeoutMs };
}

function resolveTimings(opts: ConnectOptions): Timings {
  const base = baseTimings(opts);
  const {
    keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
    clockJumpMs = DEFAULT_CLOCK_JUMP_MS,
    monitorMs = defaultMonitorMs(base.pingMs),
    probeMs: probeWindowMs = defaultProbeMs(base.silenceMs),
  } = opts;
  return { ...base, keepAliveMs, clockJumpMs, monitorMs, probeWindowMs };
}

function resolveHooks({
  now = Date.now,
  random = Math.random,
  addresses: readAddresses = networkSnapshot,
  scheduleRetry = setTimeout,
  createSocket = (url, clientOpts) => new WebSocket(url, clientOpts),
}: ConnectOptions): Hooks {
  return { now, random, readAddresses, scheduleRetry, createSocket };
}

function sendFrame(ws: WebSocket, m: ProgramNodeMessage): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  return true;
}

class ConnectionSession {
  private readonly timings: Timings;
  private readonly hooks: Hooks;
  private readonly monitorTimer: NodeJS.Timeout;
  private cap: number;
  private stopped = false;
  private active: ActiveSocket | null = null;
  private outage: Outage | null = null;
  private retryTimer: NodeJS.Timeout | undefined;
  private connectingTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastInboundAt: number;
  private probeDeadlineAt: number | null = null;
  private lastTickAt: number;
  private lastAddresses: string;
  private pendingJumpMs = 0;
  private pendingNetworkChanged = false;

  constructor(private readonly opts: ConnectOptions) {
    this.timings = resolveTimings(opts);
    this.hooks = resolveHooks(opts);
    this.cap = this.timings.firstMs;
    this.lastInboundAt = this.hooks.now();
    this.lastTickAt = this.lastInboundAt;
    this.lastAddresses = this.hooks.readAddresses();
    this.monitorTimer = setInterval(() => this.tick(), this.timings.monitorMs);
    this.monitorTimer.unref();
  }

  private log(line: string): void {
    const { log, key } = this.opts;
    if (!log) return;
    safeCall(() => log(cleanSingleLine(line, key, 500)));
  }

  private notifyClosed(): void {
    const { onClose } = this.opts;
    if (onClose) safeCall(() => onClose(), err => this.log(`Close handler failed: ${errMessage(err)}`));
  }

  private notifyRefused(): void {
    this.cap = this.timings.maxMs;
    const { onRefused } = this.opts;
    if (onRefused) safeCall(() => onRefused(), err => this.log(`Refusal handler failed: ${errMessage(err)}`));
  }

  private clearSocketTimers(): void {
    clearTimeout(this.connectingTimer);
    this.connectingTimer = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private retry(): void {
    clearTimeout(this.retryTimer);
    const { firstMs, maxMs } = this.timings;
    const delay = jitteredDelay(this.cap, firstMs, maxMs, this.hooks.random);
    this.cap = Math.min(this.cap * 2, maxMs);
    this.retryTimer = this.hooks.scheduleRetry(() => this.open(), delay);
  }

  private sendPing(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) safeCall(() => ws.ping());
  }

  private touchInbound(): void {
    this.lastInboundAt = this.hooks.now();
    if (this.probeDeadlineAt !== null) {
      this.probeDeadlineAt = null;
      this.pendingJumpMs = 0;
      this.pendingNetworkChanged = false;
    }
  }

  private recordShift(jumpMs: number, netChanged: boolean): void {
    if (this.outage) {
      this.outage = {
        ...this.outage,
        clockJumpMs: Math.max(this.outage.clockJumpMs, jumpMs),
        networkChanged: this.outage.networkChanged || netChanged,
      };
      return;
    }
    this.pendingJumpMs = Math.max(this.pendingJumpMs, jumpMs);
    this.pendingNetworkChanged ||= netChanged;
  }

  private wakeOrProbe(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.cap = this.timings.firstMs;
      this.open();
      return;
    }
    if (!this.active) return;
    if (!this.active.attempt.opened) return;
    this.probeDeadlineAt = this.hooks.now() + this.timings.probeWindowMs;
    this.sendPing(this.active.ws);
  }

  private isCurrent(ws: WebSocket): boolean {
    return this.active !== null && this.active.ws === ws;
  }

  private abortConnecting(ws: WebSocket, attempt: Attempt): void {
    if (!this.isCurrent(ws)) return;
    attempt.handshakeTimedOut = true;
    safeCall(() => ws.terminate());
  }

  private isSilent(at: number): boolean {
    const deadline = this.probeDeadlineAt || this.lastInboundAt + this.timings.silenceMs;
    return at >= deadline;
  }

  private checkHealth(at: number): void {
    if (!this.active) return;
    const { ws, attempt } = this.active;
    if (!attempt.opened) {
      if (at - attempt.startedAt >= this.timings.handshakeTimeoutMs) this.abortConnecting(ws, attempt);
      return;
    }
    if (this.isSilent(at)) {
      attempt.watchdog = true;
      safeCall(() => ws.terminate());
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const at = this.hooks.now();
    const elapsed = at - this.lastTickAt;
    this.lastTickAt = at;
    const { monitorMs, clockJumpMs } = this.timings;
    const jumpMs = elapsed > monitorMs + clockJumpMs ? elapsed - monitorMs : 0;
    const addresses = this.hooks.readAddresses();
    const netChanged = addresses !== this.lastAddresses;
    this.lastAddresses = addresses;
    if (jumpMs || netChanged) {
      this.recordShift(jumpMs, netChanged);
      this.wakeOrProbe();
    }
    this.checkHealth(at);
  }

  private makeSender(ws: WebSocket, report: NodeReconnect | null, state: { sent: boolean }): (m: ProgramNodeMessage) => boolean {
    return m => {
      const ok = sendFrame(ws, m);
      if (ok && report && !state.sent && m.type === 'hello') {
        state.sent = sendFrame(ws, { type: 'node.reconnect', ...report });
      }
      return ok;
    };
  }

  private invokeOnOpen(attempt: Attempt, send: (m: ProgramNodeMessage) => boolean): boolean {
    let ok = true;
    safeCall(
      () => this.opts.onOpen(send, attempt.acks, attempt.tools),
      err => {
        ok = false;
        attempt.errorCause = 'abnormal_close';
        attempt.error = nonEmpty(cleanSingleLine(errMessage(err), this.opts.key, 300));
        this.log(`Open handler failed: ${errMessage(err)}`);
      },
    );
    return ok;
  }

  private finalizeOpen(ws: WebSocket, attempt: Attempt, report: NodeReconnect | null, sent: boolean): void {
    if (report && !sent) sendFrame(ws, { type: 'node.reconnect', ...report });
    attempt.healthyOpen = true;
    this.outage = null;
    this.pendingJumpMs = 0;
    this.pendingNetworkChanged = false;
    this.cap = this.timings.firstMs;
    this.pingTimer = setInterval(() => this.sendPing(ws), this.timings.pingMs);
    this.pingTimer.unref();
  }

  private handleOpen(ws: WebSocket, attempt: Attempt): void {
    if (!this.isCurrent(ws)) return;
    clearTimeout(this.connectingTimer);
    this.connectingTimer = undefined;
    attempt.opened = true;
    this.lastInboundAt = this.hooks.now();
    this.probeDeadlineAt = null;
    const report = this.outage
      ? finishReconnect(this.outage, this.lastInboundAt, this.pendingJumpMs, this.pendingNetworkChanged)
      : null;
    this.log(connectLogLine(report));
    const state = { sent: false };
    if (!this.invokeOnOpen(attempt, this.makeSender(ws, report, state))) {
      safeCall(() => ws.terminate());
      return;
    }
    this.finalizeOpen(ws, attempt, report, state.sent);
  }

  private handleMessage(ws: WebSocket, data: WebSocket.RawData): void {
    if (!this.isCurrent(ws)) return;
    this.touchInbound();
    const msg = parseOperatorServerMessage(String(data));
    if (msg) safeCall(() => this.opts.onMessage(msg), err => this.log(`Message handler failed: ${errMessage(err)}`));
  }

  private handleError(ws: WebSocket, attempt: Attempt, err: Error & { code?: unknown }): void {
    if (!this.isCurrent(ws)) return;
    const code = errorCodeOf(err);
    const cause = causeFromError(code, err.message);
    attempt.errorCode = code;
    attempt.errorCause = cause;
    attempt.error = nonEmpty(cleanSingleLine(err.message, this.opts.key, 300));
    attempt.dnsFailed ||= cause === 'dns_error';
    if (code === 'HTTP_401') this.notifyRefused();
  }

  private recordOutage(at: number, cause: NodeDisconnectCause, code: number | null, reason: string | null, attempt: Attempt): void {
    if (attempt.healthyOpen) {
      this.outage = startOutage(at, 0, cause, code, reason, attempt, this.pendingJumpMs, this.pendingNetworkChanged);
    } else if (!this.outage) {
      this.outage = startOutage(attempt.startedAt, 1, cause, code, reason, attempt, this.pendingJumpMs, this.pendingNetworkChanged);
    } else {
      this.outage = mergeFailedRetry(this.outage, attempt, this.pendingJumpMs, this.pendingNetworkChanged);
    }
    this.pendingJumpMs = 0;
    this.pendingNetworkChanged = false;
  }

  private handleClose(ws: WebSocket, attempt: Attempt, code: number, rawReason: Buffer): void {
    if (!this.isCurrent(ws)) return;
    this.clearSocketTimers();
    this.active = null;
    this.notifyClosed();
    const reason = nonEmpty(cleanSingleLine(rawReason.toString('utf8'), this.opts.key, 200));
    const cause = causeFromClose(code, attempt);
    this.log(disconnectLogLine(cause, code, reason || attempt.error));
    if (code === 4001) this.notifyRefused();
    this.recordOutage(this.hooks.now(), cause, code, reason, attempt);
    this.retry();
  }

  private buildSocket(attempt: Attempt): WebSocket | null {
    try {
      const agent = agentForLookup(this.opts.url, this.opts.lookup);
      return this.hooks.createSocket(this.opts.url, {
        headers: { authorization: `Bearer ${this.opts.key}` },
        handshakeTimeout: this.timings.handshakeTimeoutMs,
        ...(agent ? { agent } : {}),
      });
    } catch (err) {
      const clean = nonEmpty(cleanSingleLine(errMessage(err), this.opts.key, 300));
      attempt.error = clean;
      attempt.errorCause = 'socket_error';
      this.log(disconnectLogLine('socket_error', null, clean));
      this.recordOutage(this.hooks.now(), 'socket_error', null, null, attempt);
      this.retry();
      return null;
    }
  }

  private bindSocket(ws: WebSocket, attempt: Attempt): void {
    this.active = { ws, attempt };
    this.connectingTimer = setTimeout(() => this.abortConnecting(ws, attempt), this.timings.handshakeTimeoutMs);
    ws.on('upgrade', res => {
      attempt.acks = res.headers[ACKS_HEADER] === '1';
      attempt.tools = res.headers[TOOLS_HEADER] === '1';
      res.socket.setKeepAlive(true, this.timings.keepAliveMs);
    });
    ws.on('ping', () => this.isCurrent(ws) && this.touchInbound());
    ws.on('pong', () => this.isCurrent(ws) && this.touchInbound());
    ws.on('open', () => this.handleOpen(ws, attempt));
    ws.on('message', data => this.handleMessage(ws, data));
    ws.on('error', err => this.handleError(ws, attempt, err));
    ws.on('close', (code, reason) => this.handleClose(ws, attempt, code, reason));
  }

  open(): void {
    this.retryTimer = undefined;
    if (this.stopped || this.active) return;
    const attempt = newAttempt(this.hooks.now());
    const ws = this.buildSocket(attempt);
    if (ws) this.bindSocket(ws, attempt);
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.monitorTimer);
    this.clearSocketTimers();
    const current = this.active;
    this.active = null;
    if (!current) return;
    this.notifyClosed();
    if (current.ws.readyState === WebSocket.CONNECTING) safeCall(() => current.ws.terminate());
    else safeCall(() => current.ws.close());
  }
}

/* Keeps one socket to Hornhoof open, detecting silent drops and reconnecting forever with 1-30 s jittered pauses. */
export function connect(opts: ConnectOptions): { close(): void } {
  const session = new ConnectionSession(opts);
  session.open();
  return { close: () => session.close() };
}
