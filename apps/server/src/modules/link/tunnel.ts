import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';

/* The public link as frpc needs it: its address, name and key, what the relay gave the tunnel, and where its TLS ends. */
export const Settings = z.object({
  url: z.string(),
  name: z.string(),
  key: z.string(),
  tunnel: z.record(z.string(), z.unknown()),
  mode: z.enum(['http', 'https']),
  /* A name the company's machines use and people do not: its door answers who holds the lease, and nothing else. */
  hidden: z.boolean().optional(),
});
export type TunnelSettings = z.infer<typeof Settings>;

/* The program that carries the link's traffic, as it is started. */
export type Client = { program: string; args: string[]; env?: Record<string, string> };

type Options<T> = {
  /* The settings now. Null: no link, and the client stops. Undefined: not known now, and the client it runs stays. */
  read: () => Promise<T | null | undefined>;
  /* How often the settings are read. */
  everyMs: number;
  /* The first pause before a client that ended starts again; it doubles up to a minute while it keeps ending. */
  restartMs: number;
  clientFor: (settings: T) => Client;
  /* What it says when a client starts and when there is nothing to run; the public link's own words when not given. */
  says?: { carrying: (settings: T) => string; waiting: string };
  /* Why the settings came back empty, said once before a running client is stopped. */
  why?: () => string | null;
  log: (line: string) => void;
};

const LINK_WORDS = { carrying: (settings: unknown) => `Carrying ${(settings as TunnelSettings).url} to Hornhoof.`, waiting: 'No public link: the tunnel waits.' };

const LONGEST_PAUSE_MS = 60_000;
/* A client that ran this long counts as having worked, so the next pause starts short again. */
const WORKED_MS = 60_000;

/* Wraps a reader whose tunnel registers no shared public name, such as a machine's own peer tunnel, so one empty read
   answers undefined and keeps the running frpc alive. Stopping and starting frpc again can cost up to 40 s at the relay
   and drops every open peer stream, while a one-second hiccup on the path through hornhoof.org, in the leader's mode,
   or in a stale view can leave one read empty before the next read finds the same link standing. A second empty read in
   a row answers null and stops the tunnel; TunnelKeeper itself stops at the first null so the public link under
   linkWanted and a disconnected visitor release at once. */
export function holdThroughOneEmptyRead<T>(read: () => Promise<T | null | undefined>): () => Promise<T | null | undefined> {
  let running = false;
  let sawEmpty = false;
  return async () => {
    const next = await read();
    if (next === undefined) return undefined;
    if (next !== null) {
      running = true;
      sawEmpty = false;
      return next;
    }
    if (!running) return null;
    if (!sawEmpty) {
      sawEmpty = true;
      return undefined;
    }
    running = false;
    sawEmpty = false;
    return null;
  };
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise(done => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    const gone = () => {
      clearTimeout(kill);
      child.off('exit', gone);
      child.off('error', gone);
      done();
    };
    child.once('exit', gone);
    child.once('error', gone);
    child.kill('SIGTERM');
  });
}

/* It waits while there is no link, runs the client once there is, starts it again when the settings change, and stops it
   when they go. Only a change starts it again, since each start may cost the link up to 40 s at the relay. */
export class TunnelKeeper<T = TunnelSettings> {
  private timer: NodeJS.Timeout | null = null;
  private text: string | null = null;
  private child: ChildProcess | null = null;
  private ending: Promise<void> = Promise.resolve();
  private again: NodeJS.Timeout | null = null;
  private pause: number;
  /* A read may outlast the pause between reads, and an older answer must not land after a newer one. */
  private reading = false;

  constructor(private readonly opts: Options<T>) {
    this.pause = opts.restartMs;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.text = null;
    await this.end();
  }

  private async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const settings = await this.opts.read();
    this.reading = false;
    /* The timer's going means it stopped during the read, and a client started now would outlive the stop. */
    if (settings !== undefined && this.timer) this.follow(settings);
  }

  private sayWhyStopped(): void {
    const why = this.opts.why?.();
    if (why) this.opts.log(why);
  }

  private follow(settings: T | null): void {
    const text = settings && JSON.stringify(settings);
    if (text === this.text) return;
    if (!settings) this.sayWhyStopped();
    this.text = text;
    this.pause = this.opts.restartMs;
    void this.end().then(() => {
      if (!this.timer || this.text !== text) return;
      if (text && settings) this.run(text, settings);
      else this.opts.log((this.opts.says ?? LINK_WORDS).waiting);
    });
  }

  private run(text: string, settings: T): void {
    let client: Client;
    try {
      client = this.opts.clientFor(settings);
    } catch (err) {
      this.opts.log(`The tunnel cannot use these settings (${(err as Error).message}): it waits for new ones.`);
      return;
    }
    const began = Date.now();
    this.opts.log((this.opts.says ?? LINK_WORDS).carrying(settings));
    /* Not the keeper's own environment: frpc fills in {{ .Envs.NAME }} wherever its config says so, the config carries
       what the relay gave, and that environment holds the company's secret and the database's password. */
    const child = spawn(client.program, client.args, { stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH, ...client.env } });
    this.child = child;
    child.on('error', err => {
      if (this.child === child) this.child = null;
      this.opts.log(`The tunnel client did not start: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.text !== text) return;
      if (Date.now() - began > WORKED_MS) this.pause = this.opts.restartMs;
      this.opts.log(`The tunnel client ended (${signal ?? code}); it starts again in ${Math.round(this.pause / 1000)} s.`);
      this.again = setTimeout(() => {
        this.again = null;
        if (this.text === text) this.run(text, settings);
      }, this.pause);
      this.pause = Math.min(this.pause * 2, LONGEST_PAUSE_MS);
    });
  }

  /* Stops the running client and waits until every client it started is gone. */
  private end(): Promise<void> {
    if (this.again) clearTimeout(this.again);
    this.again = null;
    const child = this.child;
    this.child = null;
    if (child) this.ending = Promise.all([this.ending, stopChild(child)]).then(() => undefined);
    return this.ending;
  }
}
