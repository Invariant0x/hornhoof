import { lookup } from 'node:dns/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { firstForwarded, passThrough, serve, socketAddress, startingAnswer, type PassOptions, type Refusal, type Target } from '../../net/proxy.js';
import { writeKeeperState, type Mode } from './state.js';
import { updaterBusy } from './updater-status.js';

export const KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 } as const;

export type KeeperOptions = {
  config: Config;
  /* Where the link and its certificate will be read from; nothing reads it until the link moves in here. */
  db: Db | null;
  app: Target;
  /* Null: no socket on the front port is front. */
  frontHost: string | null;
  log: (line: string) => void;
  /* Where the front port listens. */
  host?: string;
  ports?: { front?: number; linkHttp?: number; linkTls?: number };
  everyMs?: number;
};

const EVERY_MS = 1000;
/* Only this keeper's own frpc child reaches the link's doors, which is why they may believe what it sends. */
const LINK_HOST = '127.0.0.1';
/* Docker waits 10 s after its stop signal. A request in flight gets half of that to finish; an open socket, which never
   ends by itself, does not hold the stop up for longer. */
const STOP_GRACE_MS = 5000;

const MAINTENANCE_JSON = JSON.stringify({
  error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' },
});
const MAINTENANCE_TEXT = 'Hornhoof is installing an update. Try again in a few minutes.\nHornhoof ставит обновление. Попробуйте через несколько минут.\n';

/* A status the keeper cannot tell anything from keeps the mode it has, so a torn file never ends a maintenance. */
function modeAfter(busy: boolean | null, was: Mode): Mode {
  if (busy === null) return was;
  return busy ? 'maintenance' : 'lead';
}

/* startingAnswer already decides who gets JSON and who gets a page, so the two answers cannot split differently. */
function maintenanceAnswer(req: http.IncomingMessage): Refusal {
  const contentType = startingAnswer(req).headers['Content-Type']!;
  const body = contentType === 'application/json' ? MAINTENANCE_JSON : MAINTENANCE_TEXT;
  return { status: 503, headers: { 'Content-Type': contentType, 'Retry-After': '10' }, body };
}

/* Looked up by name each time, since a container gets a new address when it starts again. */
async function isAddressOf(name: string | null, address: string): Promise<boolean> {
  if (!name) return false;
  try {
    return (await lookup(name, { all: true })).some(found => found.address === address);
  } catch {
    return false;
  }
}

/* Anyone on the default network can reach the front port and write a header, so what it says counts only from front. */
const visitorFromFront =
  (frontHost: string | null) =>
  async (req: http.IncomingMessage): Promise<Record<string, string>> => {
    const said = firstForwarded(req);
    const believed = said !== '' && (await isAddressOf(frontHost, socketAddress(req)));
    return { 'x-forwarded-for': believed ? said : socketAddress(req) };
  };

/* What frps wrote, its first entry being the visitor. Only link traffic is ever marked as https. */
function visitorFromLink(req: http.IncomingMessage): Record<string, string> {
  return { 'x-forwarded-for': firstForwarded(req) || socketAddress(req), 'x-forwarded-proto': 'https' };
}

function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    /* It stays on: after the start an error is one failed accept, and the next visitor should still get through. */
    server.on('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeWithin(server: http.Server, ms: number): Promise<void> {
  return new Promise(resolve => {
    const giveUp = setTimeout(resolve, ms);
    server.close(() => {
      clearTimeout(giveUp);
      resolve();
    });
  });
}

/* Sets the app's mode and carries what comes in from front and the link to the app. */
export class Keeper {
  private current: Mode = 'lead';
  private timer: NodeJS.Timeout | null = null;
  private doors: http.Server[] = [];
  /* A word that cannot be written is said once in the log, not once a second. */
  private wordFails = false;

  constructor(private readonly opts: KeeperOptions) {}

  mode(): Mode {
    return this.current;
  }

  async start(): Promise<{ front: number; linkHttp: number; linkTls: number }> {
    const { host, ports, frontHost, everyMs } = this.opts;
    this.giveWord();
    const front = await this.open(visitorFromFront(frontHost), ports?.front ?? KEEPER_PORTS.front, host ?? '0.0.0.0');
    const linkHttp = await this.open(visitorFromLink, ports?.linkHttp ?? KEEPER_PORTS.linkHttp, LINK_HOST);
    this.timer = setInterval(() => this.giveWord(), everyMs ?? EVERY_MS);
    /* The link's TLS door does not exist yet, so it has no port to report. */
    return { front, linkHttp, linkTls: 0 };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.doors.map(door => closeWithin(door, STOP_GRACE_MS)));
  }

  /* The app goes by this word and keeps its mode while the word is stale, so a word that fails must stop no door. */
  private giveWord(): void {
    const dir = this.opts.config.controlDir;
    this.current = modeAfter(updaterBusy(dir), this.current);
    try {
      writeKeeperState(dir, { mode: this.current, at: new Date().toISOString(), link: null });
      this.wordFails = false;
    } catch (err) {
      if (!this.wordFails) this.opts.log(`The keeper could not write its word to the app: ${err instanceof Error ? err.message : String(err)}`);
      this.wordFails = true;
    }
  }

  private open(headers: PassOptions['headers'], port: number, host: string): Promise<number> {
    const door = serve(passThrough({ target: this.opts.app, headers, unreachable: req => this.appIsDown(req) }));
    this.doors.push(door);
    return listenOn(door, port, host);
  }

  private appIsDown(req: http.IncomingMessage): Refusal {
    return this.current === 'maintenance' ? maintenanceAnswer(req) : startingAnswer(req);
  }
}
