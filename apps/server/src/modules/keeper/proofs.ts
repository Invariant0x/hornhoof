import { randomBytes } from 'node:crypto';
import type { Term } from '../../db/net.js';
import type { Beats } from './beats.js';
import type { Clocks } from './lease.js';
import type { Sql } from './lease-store.js';
import { above } from './takeover-step.js';

/* What lets the machine that leads keep its lease once another machine holds a copy that finished: each second it
   proves anew that it is still the one the company's name leads to, or that the copy its commits wait for still
   follows it. With neither for ten seconds its lease lapses, and with a sign that another machine leads it ends at
   once. */

const EVERY_MS = 1000;
const PROBE_MS = 2000;
/* The copy states of a machine whose copy finished at least once. */
const FINISHED = ['ready', 'remaking', 'stopped', 'saving'];

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

export type LeaseProofsOptions = {
  /* A request through the company's link for who holds the lease there, with a nonce of this keeper's. */
  probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>;
  beats: Pick<Beats, 'answer' | 'all'>;
  /* This keeper's own network id, and the term it leads under while it does. */
  self: string;
  term: () => Term | null;
  /* The copy the relay's record names as the one commits wait for, at this keeper's generation; none while it names none. */
  b: () => string | null;
  now?: () => Clocks;
  everyMs?: number;
};

export class LeaseProofs {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private asking = false;
  private byLink: Clocks | null = null;
  private another = false;
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

  /* One question at the company's link: who answers there, with a nonce nobody could have kept an answer for. An
     answer of this machine proves the name still leads here as of when the question went out; one of another machine
     ends the lease. No answer in two seconds proves nothing. */
  async tick(): Promise<void> {
    if (this.stopped || this.asking) return;
    this.asking = true;
    const nonce = randomBytes(16).toString('base64url');
    const sent = this.clocks();
    try {
      const late = new Promise<null>(resolve => setTimeout(() => resolve(null), PROBE_MS).unref());
      const said = await Promise.race([this.opts.probe(nonce).catch(() => null), late]);
      if (!said || said.nonce !== nonce) return;
      if (said.machine === this.opts.self) this.byLink = newer(sent, this.byLink);
      else this.another = true;
    } finally {
      this.asking = false;
    }
  }

  /* When the newest proof was sent: a question at the link this machine itself answered, or a beat whose answer from
     the copy commits wait for said it follows this keeper's term. None while there is neither. */
  proof(): Clocks | null {
    const b = this.opts.b();
    const heard = b ? this.opts.beats.answer(b) : null;
    const follows = heard?.beat.stance.kind === 'follow' && sameTerm(heard.beat.stance.term, this.opts.term()) ? heard.sent : null;
    return newer(follows, this.byLink);
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
    this.byLink = null;
    this.another = false;
  }
}
