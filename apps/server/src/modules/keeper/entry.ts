import type { Term } from '../../db/net.js';
import { parseBeat, type Beats, type Stance } from './beats.js';
import type { Clocks } from './lease.js';
import { reasonOf } from './machine-keys.js';
import { above, nextEntryStep, nextWindow, NO_WINDOW, UNREACHED_MS, type EntrySample, type Poll, type Window } from './takeover-step.js';

/* How a keeper that would lead and holds no lease comes back in, once another machine holds a copy that finished: it
   never takes a term on its own word. Each second it looks at the company's name at hornhoof.org and at what the
   other machines that keep data said, and then asks the copy its commits waited for to promise it the next term,
   registers the name when that copy is silent and the name was its own and free long enough, takes its lease on
   either, or follows when anything says another machine led since. */

type ReentryOptions = {
  /* This keeper's own network id. */
  self: string;
  /* Whether a lease takes a proof now; null while that cannot be told. */
  needed: () => boolean | null;
  /* Whether the keeper holds a lease, hands the server over, or has not promoted yet: then there is nothing to come back to. */
  idle: () => boolean;
  /* The term this machine's database stands under; null when it never had one. */
  ownTerm: () => Promise<Term | null>;
  beats: Pick<Beats, 'all' | 'answer'>;
  /* The copy the relay's record names as the one that holds every change; none while it names none. */
  b: () => string | null;
  /* Asks that copy for the next term, on this keeper's session to it; none when no whole answer came. */
  ask: (networkId: string, term: Term) => Promise<{ status: number; body: unknown } | null>;
  /* One look at the company's name and the relay's health; null when the company has no link or it could not be asked. */
  poll: () => Promise<Poll>;
  /* The id of this keeper's own link client; null while the company has no link. */
  client: () => string | null;
  /* The registration at which this keeper's own client held the company's name while it led, as it last saw; none
     when it never saw that. */
  made?: () => number | null;
  /* The keeper's link client, which registers the company's name. */
  tunnel: { start(): void; stop(): void; runs(): boolean };
  /* Whether the sync controller has a flag to lead under. */
  flag: () => boolean;
  /* The id of the link client of another machine that keeps data, as its keeper makes it; none without a link. */
  clientOf?: (networkId: string) => string | null;
  /* The keeper follows from here on: it writes down whom, and ends, to start again as one that follows. */
  follow: () => Promise<void>;
  now?: () => Clocks;
  log: (line: string) => void;
};

export class Reentry {
  private window: Window = NO_WINDOW;
  private route: EntrySample['route'] = null;
  private registering: number | null = null;
  private asked: number | null = null;
  /* What the copy answered when it was asked for its promise. */
  private promised: { stance: Stance; sent: Clocks; at: number } | null = null;
  private granted: { sent: Clocks; term: Term } | null = null;
  private said = '';
  private working = false;
  private followed = false;
  /* It took the server over a moment ago, and has not yet seen at which generation the name is its own. */
  private fresh = false;
  private readonly clocks: () => Clocks;

  constructor(private readonly opts: ReentryOptions) {
    this.clocks = opts.now ?? (() => ({ wall: Date.now(), mono: performance.now() }));
  }

  /* What lets the keeper take a lease now, with the term to take; none until this found one. */
  entry(): { sent: Clocks; term: Term } | null {
    return this.granted;
  }

  /* The lease was taken: what led to it is used up. The link's client runs from here on. */
  taken(): void {
    this.granted = null;
    this.registering = null;
    this.fresh = false;
    this.asked = null;
    this.promised = null;
    this.shut();
    this.say('');
    if (!this.opts.tunnel.runs()) this.opts.tunnel.start();
  }

  /* The keeper just took the server over: it registered the company's name, its own nonce came back through the
     link, and its term is written. That is its proof for its first lease, which it may take at once; and the name it
     holds is its own registration, so the looks that follow keep it. */
  async promoted(): Promise<void> {
    const own = await this.opts.ownTerm();
    this.opts.tunnel.start();
    this.fresh = true;
    this.granted = { sent: this.clocks(), term: { number: Math.max(own?.number ?? 0, this.latest(own)?.number ?? 0) + 1, machine: this.opts.self, split: false } };
  }

  /* One look, each second. With a lease held, or while no proof is needed, there is nothing to come back to. */
  async tick(): Promise<void> {
    if (this.working || this.followed) return;
    if (this.opts.idle() || this.opts.needed() !== true) {
      this.shut();
      return;
    }
    this.working = true;
    try {
      await this.look();
    } catch (err) {
      this.say(`The keeper could not look for its way back to leading: ${reasonOf(err)}`);
    } finally {
      this.working = false;
    }
  }

  /* The window starts over. What is known of the relay's start stays: only a relay that started again is new. */
  private shut(): void {
    this.window = { ...this.window, since: null };
  }

  private say(line: string): void {
    if (line === this.said) return;
    this.said = line;
    if (line) this.opts.log(line);
  }

  /* The highest term any machine named in a beat, whatever it said it does, and this database's own. */
  private latest(own: Term | null): Term | null {
    let latest = own;
    for (const { beat } of this.opts.beats.all().values()) {
      const term = beat.stance.kind === 'lead' || beat.stance.kind === 'follow' || beat.stance.kind === 'idle' ? beat.stance.term : null;
      if (term && above(term, latest)) latest = term;
    }
    return latest;
  }

  /* Whether the machine whose client registered the name last says, in a beat of the last seconds, that it follows:
     it took the name and gave the server up. */
  private gaveUp(route: EntrySample['route'], now: Clocks): boolean {
    const { clientOf, beats } = this.opts;
    if (!route?.client || !clientOf) return false;
    for (const [networkId, heard] of beats.all()) {
      if (clientOf(networkId) === route.client) return heard.beat.stance.kind === 'follow' && now.mono - heard.at < UNREACHED_MS;
    }
    return false;
  }

  /* The copy's newest word: its answer to a beat, or to the ask for its promise. */
  private copy(): EntrySample['b'] {
    const networkId = this.opts.b();
    if (!networkId) return null;
    const beat = this.opts.beats.answer(networkId);
    const byBeat = beat?.sent ? { stance: beat.beat.stance, sent: beat.sent, at: beat.at } : null;
    const newest = this.promised && (!byBeat || this.promised.sent.mono >= byBeat.sent.mono) ? this.promised : byBeat;
    const answered = Math.max(byBeat?.at ?? -Infinity, this.promised?.at ?? -Infinity);
    return { networkId, answered: Number.isFinite(answered) ? answered : null, answer: newest ? { stance: newest.stance, sent: newest.sent } : null };
  }

  private async look(): Promise<void> {
    const { opts } = this;
    const client = opts.client();
    const poll = client ? await opts.poll() : null;
    this.window = nextWindow(this.window, poll, false);
    if (poll?.route.known) {
      const { state, generation } = poll.route;
      /* hornhoof.org names the client that holds the name, and nobody once the name is free. Who made the
         registration a free name stands at is then what this keeper knows itself: its own client, when that held the
         name at this very registration, or whoever it saw holding it there a look ago. A name that is free at any
         other registration is nobody's it knows, and it takes nothing by it. */
      const maker = poll.route.client ?? (generation === opts.made?.() ? client : this.route?.generation === generation ? this.route.client : null);
      this.route = { state, client: maker, generation, sent: poll.sent };
    }
    /* A look that does not know its own link client cannot tell its own registration from another machine's: it
       decides nothing by the name, and what it saw of it before is looked at again once the link is known. */
    const route = client ? this.route : null;
    if (this.fresh && this.route) {
      /* The registration it just made is the one at the generation the name stands at, when the name is its own. */
      if (this.route.state === 'held' && this.route.client === client) this.registering = this.route.generation - 1;
      this.fresh = false;
    }
    const ownTerm = await opts.ownTerm();
    const now = this.clocks();
    const step = nextEntryStep({
      now, needed: true, self: opts.self, ownTerm, latest: this.latest(ownTerm), b: this.copy(), asked: this.asked, window: this.window,
      route, registering: this.registering, client: client ?? '', tunnel: opts.tunnel.runs(), flag: opts.flag(), gaveUp: this.gaveUp(route, now),
    });
    if (step.do === 'take') return void (this.granted = { sent: step.sent, term: step.term });
    /* What let it lead a look ago lets it lead no more. */
    this.granted = null;
    if (step.do === 'wait') return this.say(`This machine does not lead yet: it waits for ${step.why}.`);
    if (step.do === 'follow') {
      opts.tunnel.stop();
      /* Written down first: only then does this keeper stop looking. One that could not write it tries again. */
      await opts.follow();
      this.followed = true;
      return this.say('Another machine leads now, or the name moved on; this machine follows.');
    }
    if (step.do === 'register') {
      this.registering = step.generation;
      opts.tunnel.start();
      return this.say("Taking the company's name at hornhoof.org again.");
    }
    if (step.do === 'stop') {
      /* Its own name at a later generation proves nothing: someone may have registered between. */
      opts.tunnel.stop();
      this.registering = null;
      this.shut();
      return this.say("The company's name was registered in between; this machine starts over.");
    }
    await this.askPromise(step.term);
  }

  /* The copy is asked for the next term. Its answer counts as its word from when the ask went out. */
  private async askPromise(term: Term): Promise<void> {
    const networkId = this.opts.b();
    if (!networkId) return;
    const sent = this.clocks();
    this.asked = sent.mono;
    const said = await this.opts.ask(networkId, term).catch(() => null);
    const beat = said?.status === 200 ? parseBeat(said.body) : null;
    if (beat && beat.machine === networkId) this.promised = { stance: beat.stance, sent, at: this.clocks().mono };
  }
}
