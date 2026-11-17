import { z } from 'zod';
import type { LeaseKind, Term } from '../../db/net.js';
import { PEER_PATHS, type Peer } from '../../net/peer-server.js';
import type { Clocks } from './lease.js';
import { TermShape } from './sql-words.js';
import { Ticker } from './ticker.js';

/* The machines that keep the company's data tell each other each second where they stand: which one leads and under
   which term, which follow it, and which is about to take the server. Each keeper sends its beat to every other one it
   has a session to and answers each beat it gets with its own, with no database in the way, so a keeper whose database
   stands still is heard all the same. */

export const BEAT_MS = 1_000;
export const BEAT_WAIT_MS = 900;

/* lead: it holds a lease of that kind under that term until that time by its wall clock, and sync is the machine the
   relay's record names as the copy commits wait for, when it names one. follow: it keeps a copy and takes nothing,
   under the term it follows. attempting: it is taking the server over. handing: it hands the server to that machine in
   a planned switch. idle: it would lead, and holds no lease now. */
export type Stance =
  | { kind: 'lead'; term: Term; lease: LeaseKind; sync: string | null; until: number }
  | { kind: 'follow'; term: Term | null }
  | { kind: 'attempting' }
  | { kind: 'handing'; to: string }
  | { kind: 'idle'; term: Term | null };

/* machine: the sender's network id. number: its place in the order. reach: how far its changes reach, as a time.
   ready: its copy holds every table and its database never led; the leader says true. full: its last write of the
   lease failed for a full disk. */
export type Beat = { machine: string; host: string; stance: Stance; number: number | null; reach: string | null; ready: boolean; full: boolean };
/* at: when it came, by this keeper's clock that never jumps. sent: for an answer, when the beat it answers was sent. */
export type Heard = { beat: Beat; at: number; sent: Clocks | null };

const NETWORK_ID = z.string().regex(/^[0-9a-f]{32}([0-9a-f]{32})?$/);
const StanceShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead'), term: TermShape, lease: z.enum(['normal', 'split', 'maintenance']), sync: NETWORK_ID.nullable(), until: z.number() }),
  z.object({ kind: z.literal('follow'), term: TermShape.nullable() }),
  z.object({ kind: z.literal('attempting') }),
  z.object({ kind: z.literal('handing'), to: NETWORK_ID }),
  z.object({ kind: z.literal('idle'), term: TermShape.nullable() }),
]);
const BeatShape = z.object({
  machine: NETWORK_ID,
  host: z.string().max(255),
  stance: StanceShape,
  number: z.number().int().min(1).nullable(),
  reach: z.iso.datetime().nullable(),
  ready: z.boolean(),
  full: z.boolean(),
});

/* A beat as another keeper sent it, or nothing for a body that is none. */
export function parseBeat(body: unknown): Beat | null {
  const parsed = BeatShape.safeParse(body);
  return parsed.success ? parsed.data : null;
}

type BeatsOptions = {
  /* This keeper's own beat, as of now. */
  self: () => Beat;
  /* The other live machines that keep data: each one's row, and the id its keeper runs under. */
  peers: () => { machine: string; networkId: string }[];
  /* One request to another data machine's keeper on the session to it; none when no whole answer came in time. */
  ask: (networkId: string, method: 'POST', path: string, body: unknown, timeoutMs: number) => Promise<{ status: number; body: unknown } | null>;
  /* Called with each beat that was kept, whether a machine sent it or answered with it. */
  onHeard?: (networkId: string, beat: Beat) => void;
  now?: () => Clocks;
  everyMs?: number;
  log: (line: string) => void;
};

const REFUSED = (status: 400 | 403): { status: number; body: unknown } => ({ status, body: { ok: false } });

export class Beats {
  private readonly ticks: Ticker;
  private readonly lasts = new Map<string, Heard>();
  private readonly answers = new Map<string, Heard>();
  private readonly flying = new Set<string>();
  private readonly clocks: () => Clocks;

  constructor(private readonly opts: BeatsOptions) {
    this.clocks = opts.now ?? (() => ({ wall: Date.now(), mono: performance.now() }));
    this.ticks = new Ticker(() => this.tick(), opts.everyMs ?? BEAT_MS);
  }

  start(): void {
    this.ticks.start();
  }

  stop(): void {
    this.ticks.stop();
  }

  /* One round: a beat to each machine that has none on its way. It ends once each of them was answered or given up. */
  async tick(): Promise<void> {
    if (this.ticks.stopped) return;
    await Promise.all(this.opts.peers().map(peer => this.beat(peer.networkId)));
  }

  /* A beat another keeper sent: taken only from a data machine of the company, and only as that machine's own. */
  handle(peer: Peer, body: unknown): { status: number; body: unknown } {
    const beat = parseBeat(body);
    if (!beat) return REFUSED(400);
    const row = this.opts.peers().find(known => known.networkId === beat.machine);
    if (peer.role !== 'data' || !row || row.machine !== peer.machine) return REFUSED(403);
    this.lasts.set(beat.machine, { beat, at: this.clocks().mono, sent: null });
    this.opts.onHeard?.(beat.machine, beat);
    return { status: 200, body: this.opts.self() };
  }

  /* This keeper's own beat, as it would send it now. */
  own(): Beat {
    return this.opts.self();
  }

  /* The newest beat from that machine, whether it sent it or answered with it. */
  last(networkId: string): Heard | null {
    return this.lasts.get(networkId) ?? null;
  }

  /* The newest answer of that machine to a beat of this keeper's, with when that beat was sent. */
  answer(networkId: string): Heard | null {
    return this.answers.get(networkId) ?? null;
  }

  all(): ReadonlyMap<string, Heard> {
    return this.lasts;
  }

  private async beat(networkId: string): Promise<void> {
    if (this.flying.has(networkId)) return;
    this.flying.add(networkId);
    /* Taken right before the beat goes out: what its answer proves, it proves as of then. */
    const sent = this.clocks();
    try {
      const said = await this.opts.ask(networkId, 'POST', PEER_PATHS.beat, this.opts.self(), BEAT_WAIT_MS).catch(() => null);
      const beat = said?.status === 200 ? parseBeat(said.body) : null;
      if (!beat || beat.machine !== networkId) return;
      const heard = { beat, at: this.clocks().mono, sent };
      this.lasts.set(networkId, heard);
      this.answers.set(networkId, heard);
      this.opts.onHeard?.(networkId, beat);
    } finally {
      this.flying.delete(networkId);
    }
  }
}
