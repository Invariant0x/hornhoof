import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/* What the app writes into the control folder for the public link: its address, name and key, and what the relay gave
   the tunnel. */
const Settings = z.object({ url: z.string(), name: z.string(), key: z.string(), tunnel: z.record(z.string(), z.unknown()) });
export type TunnelSettings = z.infer<typeof Settings>;

/* The program that carries the link's traffic, as it is started. */
export type Client = { program: string; args: string[]; env?: Record<string, string> };

type Options = {
  file: string;
  /* How often the settings file is read. */
  everyMs: number;
  /* The first pause before a client that ended starts again; it doubles up to a minute while it keeps ending. */
  restartMs: number;
  clientFor: (settings: TunnelSettings) => Client;
  log: (line: string) => void;
};

const LONGEST_PAUSE_MS = 60_000;
/* A client that ran this long counts as having worked, so the next pause starts short again. */
const WORKED_MS = 60_000;

/* The tunnel container's whole job: it waits while the app has written no settings, runs the client with them once it
   has, starts it again with new ones, and stops it when they go. It reads only that one file, so the container needs
   no Docker socket and nothing from the app but the control folder. */
export class TunnelKeeper {
  private timer: NodeJS.Timeout | null = null;
  private text: string | null = null;
  private child: ChildProcess | null = null;
  private again: NodeJS.Timeout | null = null;
  private pause: number;

  constructor(private readonly opts: Options) {
    this.pause = opts.restartMs;
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.everyMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.text = null;
    await this.end();
  }

  private read(): string | null {
    try {
      return readFileSync(this.opts.file, 'utf8');
    } catch {
      return null;
    }
  }

  private tick(): void {
    const text = this.read();
    if (text === this.text) return;
    this.text = text;
    this.pause = this.opts.restartMs;
    void this.end().then(() => {
      if (this.text !== text || text === null) {
        if (text === null) this.opts.log('No public link: the tunnel waits.');
        return;
      }
      const settings = this.parse(text);
      if (settings) this.run(text, settings);
    });
  }

  private parse(text: string): TunnelSettings | null {
    try {
      return Settings.parse(JSON.parse(text));
    } catch {
      this.opts.log('Hornhoof cannot read the tunnel settings: the tunnel waits for the app to write them again.');
      return null;
    }
  }

  private run(text: string, settings: TunnelSettings): void {
    let client: Client;
    try {
      client = this.opts.clientFor(settings);
    } catch (err) {
      this.opts.log(`The tunnel cannot use these settings (${(err as Error).message}): it waits for the app to write new ones.`);
      return;
    }
    const began = Date.now();
    this.opts.log(`Carrying ${settings.url} to Hornhoof.`);
    const child = spawn(client.program, client.args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...client.env } });
    this.child = child;
    child.on('error', err => this.opts.log(`The tunnel client did not start: ${err.message}`));
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

  /* Stops the running client and waits until it is gone. */
  private end(): Promise<void> {
    if (this.again) clearTimeout(this.again);
    this.again = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(done => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        done();
      });
      child.kill('SIGTERM');
    });
  }
}
