import type { Build, Registry, Siblings } from './registry.js';

export type UpdateState = { checkedAt: string | null; latest: Build | null; versions: Build[]; error: string | null };

/* Asks the registry for newer builds now and then. A failed check keeps the last good answer and says what went wrong. */
export class UpdateCheck {
  #state: UpdateState = { checkedAt: null, latest: null, versions: [], error: null };
  #running: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { registry: Registry; everyMs: number; onError?: (err: unknown) => void }) {}

  /* The first check runs at once; then every everyMs. 0 means only when asked. */
  start(): void {
    if (this.opts.everyMs <= 0 || this.#timer) return;
    void this.now();
    this.#timer = setInterval(() => void this.now(), this.opts.everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /* One check at a time: asking during a check waits for that one. */
  now(): Promise<void> {
    this.#running ??= this.#check().finally(() => (this.#running = null));
    return this.#running;
  }

  state(): UpdateState {
    return this.#state;
  }

  /* Read when someone updates, so the node and updater images are the ones of the build's commit then. */
  siblings(tag: string): Promise<Siblings> {
    return this.opts.registry.siblings(tag);
  }

  /* The build of one tag, as a commit's is, for whoever needs to know a build that is no newer one. */
  find(tag: string): Promise<Build | null> {
    return this.opts.registry.find(tag);
  }

  async #check(): Promise<void> {
    try {
      const [latest, versions] = await Promise.all([this.opts.registry.latest(), this.opts.registry.versions()]);
      this.#state = { checkedAt: new Date().toISOString(), latest, versions, error: null };
    } catch (err) {
      this.#state = { ...this.#state, error: err instanceof Error ? err.message : String(err) };
      this.opts.onError?.(err);
    }
  }
}
