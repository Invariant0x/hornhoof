import { judgeLiveCheck, type LiveCheckVerdict } from '@hornhoof/protocol/live-check';
import { FULL_SHA, type Build, type Registry, type Siblings } from './registry.js';

/* liveCheck: what the latest build's live check says; nobody is offered a build it says no to. */
export type UpdateState = { checkedAt: string | null; latest: Build | null; liveCheck: LiveCheckVerdict | null; versions: Build[]; error: string | null };

const NO_PROOF: LiveCheckVerdict = { ok: false, reason: 'missing' };

/* Asks the registry for newer builds now and then. A failed check keeps the last good answer and says what went wrong. */
export class UpdateCheck {
  #state: UpdateState = { checkedAt: null, latest: null, liveCheck: null, versions: [], error: null };
  /* The commit this server runs once its live check said yes: a proof stays true of its images. */
  #provenOwn: string | null = null;
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

  /* The verdict on a build by what the registry holds now, with the node and updater images it was read with. */
  async liveCheck(build: Build, siblings: Siblings): Promise<LiveCheckVerdict> {
    if (!FULL_SHA.test(build.commit)) return NO_PROOF;
    return judgeLiveCheck(await this.opts.registry.liveCheck(build.commit), { ...build, ...siblings });
  }

  /* The verdict on the build this server runs, which its nodes go to. Nodes ask every few seconds while they wait. */
  async ownLiveCheck(commit: string): Promise<LiveCheckVerdict> {
    if (this.#provenOwn === commit) return { ok: true };
    const build = await this.opts.registry.buildOf(commit);
    if (!build) return NO_PROOF;
    const verdict = await this.liveCheck(build, await this.opts.registry.siblings(commit));
    if (verdict.ok) this.#provenOwn = commit;
    return verdict;
  }

  async #check(): Promise<void> {
    try {
      const [latest, versions] = await Promise.all([this.opts.registry.latest(), this.opts.registry.versions()]);
      const liveCheck = latest ? await this.liveCheck(latest, await this.opts.registry.siblings(FULL_SHA.test(latest.commit) ? latest.commit : latest.tag)) : null;
      this.#state = { checkedAt: new Date().toISOString(), latest, liveCheck, versions, error: null };
    } catch (err) {
      this.#state = { ...this.#state, error: err instanceof Error ? err.message : String(err) };
      this.opts.onError?.(err);
    }
  }
}
