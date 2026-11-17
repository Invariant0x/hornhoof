import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Term } from '../../db/net.js';
import type { Route, SyncRecord } from '../link/relay.js';
import type { Beat, Beats, Stance } from './beats.js';
import type { Clocks } from './lease.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { readNote } from './notes.js';
import { TermShape } from './sql-words.js';
import type { Taking } from './switch-step.js';
import { above, nextWatchStep, nextWindow, NO_WINDOW, promiseAnswer, SILENT_MS, TAKE_MS, type Poll, type WatchSample, type Window } from './takeover-step.js';
import { Ticker } from './ticker.js';

/* The watch a machine that keeps a copy holds over the machine it follows. Each second it looks at the company's name
   at hornhoof.org, at the relay's health, at what answers at the company's link and at the leader's beats. When the
   leader has been gone long enough and the relay says this copy holds every confirmed change, it takes the server
   over; when it may lack changes, it asks the CEO. It also keeps the term it follows, and promises the next one only
   to the machine it follows. */

export const FOLLOWED_FILE = 'followed.json';
const EVERY_MS = 1000;
const ASK_MS = 2000;
/* The leader silent this long: from here hornhoof.org and the company's link are asked each second. */
const ASK_FROM_MS = 3000;
/* While the leader is heard, hornhoof.org is asked this seldom, only to know when its relay started. */
const SELDOM_MS = 60_000;
const Followed = z.object({ term: TermShape });

/* The term this copy follows, as it wrote it down; none when it wrote none, or when the note cannot be read: a copy
   that does not know what it follows promises nothing. */
export function readFollowed(dir: string): Term | null {
  try {
    return readNote(join(dir, FOLLOWED_FILE), Followed, 'the term it follows')?.term ?? null;
  } catch {
    return null;
  }
}

/* Written whole and then moved, so a keeper that starts again never reads half of it. */
export function writeFollowed(dir: string, term: Term): void {
  writePrivately(join(dir, FOLLOWED_FILE), JSON.stringify({ term }));
}

export type WatcherOptions = {
  /* The keeper's own folder. */
  dir: string;
  self: { networkId: string };
  /* The company's link as this keeper may ask the relay of it; none without one. */
  link: () => { name: string; key: string } | null;
  relay: { route(name: string, key: string, timeoutMs?: number): Promise<Route>; health(timeoutMs?: number): Promise<{ up: boolean; relayStarted: number | null }> };
  /* A request through the company's link for who holds the lease there, with a nonce of this keeper's. */
  probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>;
  beats: Pick<Beats, 'last' | 'all'>;
  /* This keeper's own beat, which a promise is answered with. */
  beat: () => Beat;
  /* The machine this copy was made on or last joined, as its maker wrote it down: never the one its link names now,
     so a lost session or a restart does not erase whom it watches. */
  leader: () => { networkId: string } | null;
  /* Whether its copy holds every table and its database never led. */
  ready: () => boolean;
  /* Whether an update promise or a planned switch's offer holds: nothing is watched meanwhile. */
  holds: () => boolean;
  /* How far its copy's changes reach, as a time. */
  reach: () => string | null;
  /* Writes the takeover down and ends the keeper, which starts again as the one that takes the server. */
  take: (taking: Taking) => Promise<void>;
  /* The question to the CEO stands from now, or is gone. */
  ask: (on: boolean, sample: WatchSample) => void;
  /* When the CEO said to go on from this copy, by this keeper's clock that never jumps; null while he did not. */
  ceo: () => number | null;
  now?: () => Clocks;
  everyMs?: number;
  log: (line: string) => void;
};

export class Watcher {
  private readonly ticks: Ticker;
  private working = false;
  private probing = false;
  private readonly started: number;
  private window: Window = NO_WINDOW;
  private held = true;
  private generation: number | null = null;
  private record: SyncRecord | null = null;
  /* When the leader was last heard leading: a beat of it that said so, or a promise this copy gave it. */
  private lastBeat: number | null = null;
  private polledAt: number | null = null;
  private linkAnswered: number | null = null;
  private syncBeat: number | null = null;
  private asked = false;
  private decided = false;
  /* Whether hornhoof.org answered the last look at it; null before the first. */
  private up: boolean | null = null;
  private term: Term | null;
  private failing = false;
  private readonly clocks: () => Clocks;

  constructor(private readonly opts: WatcherOptions) {
    this.clocks = opts.now ?? (() => ({ wall: Date.now(), mono: performance.now() }));
    this.ticks = new Ticker(() => this.tick(), opts.everyMs ?? EVERY_MS);
    this.started = this.clocks().mono;
    this.term = readFollowed(opts.dir);
  }

  start(): void {
    this.ticks.start();
  }

  stop(): void {
    this.ticks.stop();
  }

  /* True from the turn it decided to take the server over. */
  attempting(): boolean {
    return this.decided;
  }

  /* The term this copy follows. */
  followed(): Term | null {
    return this.term;
  }

  /* Whether this machine reached hornhoof.org at its last look there; null while it has not looked. */
  relayUp(): boolean | null {
    return this.up;
  }

  /* The leader answers at the company's link and not this copy's beats: this copy is cut off from it, and takes
     nothing. */
  cut(): boolean {
    const now = this.clocks().mono;
    const silent = now - Math.max(this.lastBeat ?? this.started, this.started) >= SILENT_MS;
    return silent && this.linkAnswered !== null && now - this.linkAnswered < SILENT_MS;
  }

  stance(): Stance {
    return this.decided ? { kind: 'attempting' } : { kind: 'follow', term: this.term };
  }

  /* A beat or an answer of another machine that keeps data. The leader's term is the one this copy follows: taken
     from the machine it watches alone, and only a term above the one it keeps. */
  heard(from: string, beat: Beat): void {
    if (from !== this.opts.leader()?.networkId || beat.stance.kind !== 'lead') return;
    if (this.term && !above(beat.stance.term, this.term)) return;
    this.follow(beat.stance.term);
  }

  /* The machine it follows asks for the next term. The grant is written down before it is answered, and the answer is
     this keeper's own beat, whose stance says what was decided. */
  promise(from: string, body: unknown): { status: number; body: unknown } {
    const asked = body !== null && typeof body === 'object' && 'term' in body ? (body as { term: unknown }).term : undefined;
    if (asked === undefined) return { status: 400, body: { ok: false } };
    const answer = promiseAnswer({ asker: from, term: asked, followed: this.term, attempting: this.decided });
    if (answer.grant) {
      this.follow(answer.grant);
      /* The leader may lead on this promise for a lease's time: it counts as hearing it lead now, so this copy takes
         nothing over meanwhile. */
      this.lastBeat = this.clocks().mono;
    }
    return { status: 200, body: this.opts.beat() };
  }

  private follow(term: Term): void {
    writeFollowed(this.opts.dir, term);
    this.term = term;
  }

  /* One look, each second. A look that fails changes nothing, and is said once an outage. */
  async tick(): Promise<void> {
    if (this.ticks.stopped || this.working || this.decided) return;
    this.working = true;
    try {
      await this.look();
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.opts.log(`The keeper could not watch the machine that leads: ${reasonOf(err)}`);
      this.failing = true;
    } finally {
      this.working = false;
    }
  }

  private async look(): Promise<void> {
    const { opts } = this;
    const leader = opts.leader();
    const last = leader ? opts.beats.last(leader.networkId) : null;
    /* Only a beat that says the leader leads, or hands the server over, is the leader leading: a keeper that beats on
       with no lease, as one whose disk is full, would lead and does not. */
    const leads = last !== null && (last.beat.stance.kind === 'lead' || last.beat.stance.kind === 'handing');
    const heardLeader = leads && (this.lastBeat === null || last.at > this.lastBeat);
    if (heardLeader) this.lastBeat = last.at;
    /* While the leader is heard nothing of the relay decides anything: it is asked once a minute, to know when it
       started. Once the leader is silent for a few seconds it is asked each second. */
    const before = this.clocks().mono;
    const asking = before - Math.max(this.lastBeat ?? this.started, this.started) >= ASK_FROM_MS;
    const due = asking || this.polledAt === null || before - this.polledAt >= SELDOM_MS;
    const poll = due ? await this.poll() : null;
    if (due) this.polledAt = before;
    if (poll) this.up = poll.health.up;
    this.window = nextWindow(this.window, poll, heardLeader);
    if (poll?.route.known) {
      this.held = poll.route.state === 'held';
      this.generation = poll.route.generation;
      this.record = poll.route.sync;
    }
    if (last && last.beat.stance.kind === 'lead' && last.beat.stance.lease === 'normal' && last.beat.stance.sync === opts.self.networkId) this.syncBeat = Math.max(this.syncBeat ?? -Infinity, last.at);
    if (leader && asking) void this.probe(leader.networkId);
    const now = this.clocks();
    const sample: WatchSample = {
      now: now.mono, started: this.started, window: this.window, held: this.held, leader: leader?.networkId ?? null, heard: this.lastBeat, linkAnswered: this.linkAnswered,
      syncBeat: this.syncBeat, record: this.record, routeGeneration: this.generation, self: opts.self.networkId, ready: opts.ready(), holds: opts.holds(), ceo: opts.ceo(),
    };
    const { action } = nextWatchStep(sample, this.asked);
    if (action.do === 'ask' || action.do === 'unask') {
      this.asked = action.do === 'ask';
      opts.log(this.asked ? 'This copy may lack changes; asking the CEO.' : 'The question is gone.');
      opts.ask(this.asked, sample);
    }
    if (action.do !== 'take' || !leader) return;
    /* Decided in this same turn, before anything is awaited: from here it promises nothing. */
    this.decided = true;
    try {
      await opts.take({
        switch: randomUUID(), from: { networkId: leader.networkId }, term: this.highest(leader.networkId), at: now.wall, deadline: now.wall + TAKE_MS, phase: 'go',
        w: null, copies: null, slots: null, why: null, kind: action.kind,
        heard: this.lastBeat === null ? null : now.wall - (now.mono - this.lastBeat), reach: opts.reach(), full: last?.beat.full ?? false, generation: this.generation ?? undefined,
      });
    } catch (err) {
      /* Nothing was written down: it is not taking the server, and its window starts over. */
      this.decided = false;
      this.window = { ...this.window, since: null };
      throw err;
    }
  }

  /* The route of the company's name and the relay's health, asked at once; none without a link. */
  private async poll(): Promise<Poll> {
    const link = this.opts.link();
    if (!link) return null;
    const sent = this.clocks();
    const [route, health] = await Promise.all([this.opts.relay.route(link.name, link.key, ASK_MS), this.opts.relay.health(ASK_MS)]);
    return { sent, replied: this.clocks().mono, route, health: { up: health.up, relayStarted: health.relayStarted } };
  }

  /* One question at the company's link at a time: whether the leader's machine still answers there. */
  private async probe(leader: string): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    const nonce = randomBytes(16).toString('base64url');
    try {
      const late = new Promise<null>(resolve => setTimeout(() => resolve(null), ASK_MS).unref());
      const said = await Promise.race([this.opts.probe(nonce).catch(() => null), late]);
      if (said && said.nonce === nonce && said.machine === leader) this.linkAnswered = this.clocks().mono;
    } finally {
      this.probing = false;
    }
  }

  /* The highest term this copy knows: the one it follows and every one a beat named; with none, a term below every
     term of the leader. */
  private highest(leader: string): Term {
    let highest = this.term;
    for (const { beat } of this.opts.beats.all().values()) {
      const term = beat.stance.kind === 'lead' || beat.stance.kind === 'follow' || beat.stance.kind === 'idle' ? beat.stance.term : null;
      if (term && above(term, highest)) highest = term;
    }
    return highest ?? { number: 0, machine: leader, split: false };
  }
}
