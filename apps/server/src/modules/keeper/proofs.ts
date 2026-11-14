import { randomBytes } from 'node:crypto';
import type { Term } from '../../db/net.js';
import type { Beats, Heard } from './beats.js';
import { LEASE_MS, type Clocks } from './lease.js';
import type { Sql } from './lease-store.js';
import { above } from './takeover-step.js';

/* What lets the machine that leads keep its lease once another machine holds a copy that finished: each second it
   proves anew that it is still the one the company's name leads to, or that the copy its commits wait for still
   follows it. With neither for ten seconds its lease lapses, and with a sign that another machine leads it ends at
   once. */

const EVERY_MS = 1000;
const PROBE_MS = 5000;
const MAX_PROBES = 5;
const LATE = Symbol('late');
/* The copy states of a machine whose copy finished at least once. */
const FINISHED = ['ready', 'remaking', 'stopped', 'saving'];

type ProbeAnswer = { machine: string; nonce: string } | null;
type ProbeRace = { ok: true; value: ProbeAnswer } | { ok: false } | typeof LATE;
type LinkMiss = 'idle' | 'asking' | 'silent' | 'timeout' | 'failed' | 'stale';

const LINK_MISS: Record<LinkMiss, string> = {
  idle: 'link not probed yet',
  asking: 'link probe in flight',
  silent: 'no answer from link probe',
  timeout: 'link probe timed out',
  failed: 'link probe failed',
  stale: 'link probe returned another nonce',
};

/* Whether another live machine that holds the data has a copy that finished at least once, or is the machine the
   newest handover names as the leader before: that one holds a database that led. Until then a machine leads as one
   that keeps the data alone does, with no proof. */
export async function othersFinished(sql: Sql, networkId: string): Promise<boolean> {
  /* A database of the build before the network has no copies to speak of, and none of the tables this asks. */
  const [known] = (await sql.query<{ there: boolean }>(HAS_COPIES)).rows;
  if (!known?.there) return false;
  const { rows } = await sql.query<{ there: boolean }>(
    `SELECT EXISTS (
       SELECT FROM machines m
        WHERE m.revoked_at IS NULL AND m.role = 'data' AND m.network_id IS NOT NULL AND m.network_id <> $1
          AND (m.copy_state = ANY($2::text[]) OR m.id = (SELECT h.from_machine_id FROM net.handovers h ORDER BY h.at DESC LIMIT 1))
     ) AS there`,
    [networkId, FINISHED],
  );
  return rows[0]?.there === true;
}

/* Whether this database knows of copies and handovers at all. */
const HAS_COPIES = `SELECT to_regclass('net.handovers') IS NOT NULL
  AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machines' AND column_name IN ('role', 'copy_state', 'network_id', 'revoked_at')) = 4 AS there`;

const sameTerm = (a: Term | null, b: Term | null): boolean => a !== null && b !== null && a.number === b.number && a.machine === b.machine && a.split === b.split;
const newer = (a: Clocks | null, b: Clocks | null): Clocks | null => (a && (!b || a.mono >= b.mono) ? a : b);

function copyFollows(heard: Heard | null, term: Term | null): Clocks | null {
  return heard?.beat.stance.kind === 'follow' && sameTerm(heard.beat.stance.term, term) ? heard.sent : null;
}

function heardMiss(beat: Heard['beat'], term: Term | null): string {
  const name = beat.host.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || 'sync copy';
  if (beat.stance.kind !== 'follow') return `${name} stance is ${beat.stance.kind}`;
  return sameTerm(beat.stance.term, term) ? `no new beat from ${name}` : `${name} follows another term`;
}

function copyMiss(b: string | null, heard: Heard | null, term: Term | null): string {
  if (!b) return 'no sync copy named';
  return heard ? heardMiss(heard.beat, term) : 'no beat answer from sync copy';
}

function classifyMiss(said: ProbeRace, nonce: string): LinkMiss | null {
  if (said === LATE) return 'timeout';
  if (!said.ok) return 'failed';
  if (!said.value) return 'silent';
  return said.value.nonce === nonce ? null : 'stale';
}

export type LeaseProofsOptions = {
  /* A request through the company's link for who holds the lease there, with a nonce of this keeper's. */
  probe: (nonce: string) => Promise<ProbeAnswer>;
  beats: Pick<Beats, 'answer' | 'all'>;
  /* This keeper's own network id, and the term it leads under while it does. */
  self: string;
  term: () => Term | null;
  /* The copy the relay's record names as the one commits wait for, at this keeper's generation; none while it names none. */
  b: () => string | null;
  now?: () => Clocks;
  everyMs?: number;
  probeMs?: number;
};

export class LeaseProofs {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight = 0;
  private epoch = 0;
  private byLink: Clocks | null = null;
  private began: Clocks | null = null;
  private another = false;
  private linkMiss: LinkMiss = 'idle';
  private missingSaid = '';
  private readonly clocks: () => Clocks;

  constructor(private readonly opts: LeaseProofsOptions) {
    this.clocks = opts.now ?? (() => ({ wall: Date.now(), mono: performance.now() }));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* Lets a lease that stood before proofs were needed stand from when they began to be, while the first proof is
     asked for. */
  begin(): void {
    this.began = newer(this.clocks(), this.began);
  }

  /* One question at the company's link: who answers there, with a nonce nobody could have kept an answer for. An
     answer of this machine proves the name still leads here as of when the question went out; one of another machine
     ends the lease. No answer in five seconds proves nothing. */
  async tick(): Promise<void> {
    if (this.stopped || this.inFlight >= MAX_PROBES) return;
    this.inFlight += 1;
    const epoch = this.epoch;
    const nonce = randomBytes(16).toString('base64url');
    const sent = this.clocks();
    try {
      const said = await this.raceProbe(nonce);
      if (this.stopped || epoch !== this.epoch) return;
      this.applyProbe(said, nonce, sent);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async raceProbe(nonce: string): Promise<ProbeRace> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>(resolve => {
      timer = setTimeout(() => resolve(LATE), this.opts.probeMs ?? PROBE_MS);
      timer.unref();
    });
    try {
      const asked = this.opts.probe(nonce).then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private applyProbe(said: ProbeRace, nonce: string, sent: Clocks): void {
    const miss = classifyMiss(said, nonce);
    if (miss) {
      this.linkMiss = miss;
      return;
    }
    const answer = (said as { ok: true; value: NonNullable<ProbeAnswer> }).value;
    if (answer.machine === this.opts.self) {
      this.byLink = newer(sent, this.byLink);
      this.linkMiss = 'idle';
    } else this.another = true;
  }

  private vouched(): Clocks | null {
    const b = this.opts.b();
    const follows = b ? copyFollows(this.opts.beats.answer(b), this.opts.term()) : null;
    return newer(follows, this.byLink);
  }

  /* When the newest proof was sent: a question at the link this machine itself answered, a beat whose answer from the
     copy commits wait for said it follows this keeper's term, or when proofs first became needed under a standing lease. */
  proof(): Clocks | null {
    return newer(this.vouched(), this.began);
  }

  private linkWhy(): string {
    if (this.linkMiss !== 'idle') return LINK_MISS[this.linkMiss];
    if (this.inFlight > 0) return LINK_MISS.asking;
    return this.byLink ? 'no new answer from link probe' : LINK_MISS.idle;
  }

  /* Why neither proof renewed the lease: what happened at the link, and why no beat from the named copy vouches for it. */
  missing(): string {
    const b = this.opts.b();
    const heard = b ? this.opts.beats.answer(b) : null;
    return `${this.linkWhy()}; ${copyMiss(b, heard, this.opts.term())}`;
  }

  /* Says which proof is missing when a standing lease went past a renewal tick with no newer proof; once for each
     reason, and forgotten again once a newer proof arrives or the lease is taken anew. */
  reportMissing(untilWall: number, log: (line: string) => void): void {
    const lastWall = untilWall - LEASE_MS;
    const vouched = this.vouched();
    if (vouched && vouched.wall > lastWall) {
      this.missingSaid = '';
      return;
    }
    const needMs = this.linkMiss === 'idle' ? 2 * EVERY_MS : EVERY_MS;
    if (this.clocks().wall - lastWall < needMs) return;
    this.sayMissing(`Lease renewal skipped (missing proof: ${this.missing()}).`, log);
  }

  private sayMissing(line: string, log: (line: string) => void): void {
    if (line === this.missingSaid) return;
    this.missingSaid = line;
    log(line);
  }

  /* Why the lease must end now, whatever its time: another machine answers at the company's link, or a machine says
     in a beat that it leads under a term above this keeper's. Null while neither is so. */
  ended(): string | null {
    if (this.another) return 'another machine answers at the link';
    const term = this.opts.term();
    if (!term) return null;
    for (const { beat } of this.opts.beats.all().values()) {
      if (beat.stance.kind === 'lead' && above(beat.stance.term, term)) return `${beat.host || 'another machine'} leads under term ${beat.stance.term.number}`;
    }
    return null;
  }

  /* Forgets the proofs and the sign that another machine answers: the keeper calls it at each take. */
  clear(): void {
    this.epoch += 1;
    this.byLink = null;
    this.began = null;
    this.another = false;
    this.linkMiss = 'idle';
    this.missingSaid = '';
  }
}
