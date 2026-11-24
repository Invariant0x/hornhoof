import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { sealBundle, type BundleSecrets } from '../backups/bundle.js';
import { BundleStore } from '../backups/store.js';
import type { MakerView } from '../backups/types.js';
import { BUNDLES_DIR } from './backups.js';
import type { HeldCertificate } from './certificate.js';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately, type MachineKey } from './machine-keys.js';
import { readNote } from './notes.js';
import { dropSlots, waitForNoCopy } from './promote.js';
import { lsnAtOrPast, walOf } from './sql-words.js';

/* A machine that led the company and follows another now holds a database nobody else has whole: what it did while it
   led, as far as the new leader lacks it. Before its copy is made again, its keeper saves that database: its updater
   dumps it, the keeper seals the dump as a backup of the company, signs it and gives it to the keeper that leads,
   which records it. When the current leader already applied every WAL byte this database wrote while it led, the save
   is skipped so the copy can be made again right away. Each step is looked at first, so a keeper that starts again in
   the middle goes on. */

export const LED_FILE = 'led.json';
const EVERY_MS = 10_000;
/* A dump that failed is asked for again after this long. */
export const LED_RETRY_MS = 600_000;
const DUMP_FILE = 'dump.json';
const DUMPS_DIR = 'dumps';
const DATABASE = 'hornhoof';

export const SAVING_WAITS = ['dump', 'seal', 'server', 'send', 'retry'] as const;
export type SavingWait = (typeof SAVING_WAITS)[number];
export type AppliedLed = { term: number; lsn: string };

/* id: the bundle's id. term: the number of the term the database led under. lsn: where its WAL stood when saving began.
   asked: when its dump was asked for last. sealed: the bundle lies in this keeper's own store. recorded: the keeper
   that leads took and recorded it, or already holds everything up to lsn. failed: why the updater could not dump, until
   it is asked again. */
const LedShape = z.object({
  id: z.uuid(),
  term: z.number().int().min(0),
  lsn: z.string().optional(),
  asked: z.string().nullable(),
  sealed: z.boolean(),
  recorded: z.boolean(),
  skipped: z.boolean().optional(),
  failed: z.string().nullable(),
  at: z.string(),
});
type LedState = z.infer<typeof LedShape>;
export type LedStatus = LedState & { waiting: SavingWait; since: string };

/* What this keeper wrote down of saving the database that led; none when it wrote nothing, or nothing it can read. */
export function readLed(dir: string): LedState | null {
  try {
    return readNote(join(dir, LED_FILE), LedShape, 'saving the database that led');
  } catch {
    return null;
  }
}

const DumpShape = z.object({ id: z.string(), reason: z.literal('fork'), at: z.string(), migrations: z.number().int().min(0) });

export type LedSaverOptions = {
  /* The keeper's own folder, and the control folder it shares with its updater. */
  dir: string;
  controlDir: string;
  bundles?: BundleStore;
  /* This machine's own database, the one that led. */
  sql: Sql;
  wal?: { position(): Promise<string> };
  key: MachineKey;
  held: () => HeldCertificate | null;
  /* The machine's own key for backups: the bundle is sealed to it too. */
  age: () => Promise<{ recipient: string }>;
  secrets: () => BundleSecrets;
  /* The machine that leads now, by its network id. */
  leader: () => { networkId: string } | null;
  /* Whom the company's backups are sealed to, as the keeper that leads is told it by its app. */
  view: () => Promise<MakerView | null>;
  /* Gives the bundle to the keeper that leads, as it travels: its head, then its sealed part. The status that keeper
     answered, none when it did not. */
  put: (networkId: string, id: string, bundle: { length: number; stream(): Readable }) => Promise<number | null>;
  now?: () => Date;
  everyMs?: number;
  log: (line: string) => void;
};

export class LedSaver {
  private led: LedState | null;
  private working: Promise<void> | null = null;
  private lastFailure: string | null = null;
  private step: SavingWait;
  private readonly bundles: BundleStore;

  constructor(private readonly opts: LedSaverOptions) {
    this.led = readLed(opts.dir);
    this.step = this.led?.sealed ? 'send' : 'dump';
    this.bundles = opts.bundles ?? new BundleStore(join(opts.dir, BUNDLES_DIR));
  }

  state(): LedStatus | null {
    if (!this.led) return null;
    return { ...this.led, waiting: this.lastFailure ? 'retry' : this.step, since: this.led.at };
  }

  /* The keeper that leads recorded the bundle, or already holds everything: the database may be merged, and go once it is. */
  done(): boolean {
    return this.led?.recorded === true;
  }

  /* How often it looks. */
  pace(): number {
    return this.opts.everyMs ?? EVERY_MS;
  }

  /* The database went with its merge: nothing is left to remember of it. */
  forget(): void {
    rmSync(join(this.opts.dir, LED_FILE), { force: true });
    this.led = null;
    this.lastFailure = null;
    this.step = 'dump';
  }

  /* One look at a time. A look that fails changes nothing but what it wrote down, and logs each distinct reason once. */
  tick(applied: AppliedLed | null = null): Promise<void> {
    this.working ??= this.look(applied)
      .then(
        () => void (this.lastFailure = null),
        (err: unknown) => {
          const reason = reasonOf(err);
          if (reason !== this.lastFailure) this.opts.log(`The keeper could not save what this machine did while it led: ${reason}`);
          this.lastFailure = reason;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private wal(): { position(): Promise<string> } {
    return this.opts.wal ?? walOf(this.opts.sql);
  }

  private keep(led: LedState): LedState {
    writePrivately(join(this.opts.dir, LED_FILE), JSON.stringify(led));
    this.led = led;
    return led;
  }

  private async look(applied: AppliedLed | null): Promise<void> {
    if (this.led?.recorded) return;
    const led = this.led ?? (await this.begin(applied));
    if (!led) return;
    if (await this.skipIfCovered(led, applied)) return;
    if (!this.led!.sealed && !(await this.seal(this.led!))) return;
    await this.give(this.led!);
  }

  /* Nothing reads from this database any more, and none of its commits waits for a copy: its slots go, and the copy
     it named. When the leader already applied its last WAL position, no dump is asked for; else its dump goes under a new id. */
  private async begin(applied: AppliedLed | null): Promise<LedState | null> {
    const { sql } = this.opts;
    const [state] = (await sql.query<{ number: string }>(`SELECT term_number::text AS number FROM net_local.state s WHERE to_jsonb(s) ->> 'handed_lsn' IS NULL`)).rows;
    if (!state) return null;
    const lsn = await this.wal().position();
    await dropSlots(sql);
    await waitForNoCopy(sql);
    const fresh: LedState = { id: randomUUID(), term: Number(state.number), lsn, asked: null, sealed: false, recorded: false, failed: null, at: this.now().toISOString() };
    if (applied && applied.term === fresh.term && lsnAtOrPast(applied.lsn, lsn)) {
      this.keep({ ...fresh, recorded: true, skipped: true });
      this.opts.log('The company server already holds everything this machine did while it led; its save is skipped.');
      return null;
    }
    this.step = 'dump';
    const led = this.keep(fresh);
    this.opts.log('This machine led the company before: what it did then is saved before its copy is made again.');
    return led;
  }

  /* Skips an ongoing save once the leader reports an applied LSN for this term at or past where this database's WAL stood. */
  private async skipIfCovered(led: LedState, applied: AppliedLed | null): Promise<boolean> {
    const lsn = led.lsn ?? (await this.wal().position());
    const current = led.lsn === undefined ? this.keep({ ...led, lsn }) : led;
    if (!applied || applied.term !== current.term || !lsnAtOrPast(applied.lsn, lsn)) return false;
    this.clearDump(current.id);
    this.keep({ ...current, recorded: true, skipped: true, failed: null });
    this.opts.log('The company server already holds everything this machine did while it led; its save is skipped.');
    return true;
  }

  private clearDump(id: string): void {
    const request = join(this.opts.controlDir, DUMP_FILE);
    try {
      if ((JSON.parse(readFileSync(request, 'utf8')) as { id?: unknown }).id === id) rmSync(request, { force: true });
    } catch {
      /* No request, or not one to read. */
    }
    const dumps = join(this.opts.controlDir, DUMPS_DIR);
    for (const end of ['.sql.gz', '.json', '.failed']) rmSync(join(dumps, `${id}${end}`), { force: true });
  }

  private noteDumpFailure(led: LedState, failedPath: string): false {
    let why = '';
    try {
      why = readFileSync(failedPath, 'utf8').trim().slice(0, 200);
    } catch {
      /* Not readable: the line goes without it. */
    }
    rmSync(failedPath, { force: true });
    this.step = 'retry';
    this.keep({ ...led, failed: why || 'The database could not be dumped.' });
    this.opts.log(`The updater could not dump the database this machine led with${why ? `: ${why}` : '.'}`);
    return false;
  }

  private requestDumpIfDue(led: LedState): false {
    const request = join(this.opts.controlDir, DUMP_FILE);
    const asked = led.asked === null ? null : Date.parse(led.asked);
    const due = asked === null || (led.failed !== null && this.now().getTime() - asked >= LED_RETRY_MS);
    if (due && !existsSync(request)) {
      writePrivately(request, JSON.stringify({ id: led.id, database: DATABASE, reason: 'fork' }));
      this.keep({ ...led, asked: this.now().toISOString(), failed: asked === null ? null : led.failed });
    }
    this.step = led.failed === null ? 'dump' : 'retry';
    return false;
  }

  /* The dump is asked of the updater, and sealed once it is there. True once the bundle lies in this keeper's store. */
  private async seal(led: LedState): Promise<boolean> {
    const { opts } = this;
    const dumps = join(opts.controlDir, DUMPS_DIR);
    const [file, said, failed] = [join(dumps, `${led.id}.sql.gz`), join(dumps, `${led.id}.json`), join(dumps, `${led.id}.failed`)];
    if (this.bundles.has(led.id)) {
      this.keep({ ...led, sealed: true, failed: null });
      return true;
    }
    if (existsSync(failed)) return this.noteDumpFailure(led, failed);
    if (!existsSync(said) || !existsSync(file)) return this.requestDumpIfDue(led);
    const dump = DumpShape.safeParse(JSON.parse(readFileSync(said, 'utf8')));
    if (!dump.success || dump.data.id !== led.id) throw new Error('the dump the updater left says it is another one');
    const held = opts.held();
    const view = await opts.view();
    if (!held || !view?.company) {
      this.step = 'server';
      return false;
    }
    this.step = 'seal';
    const company = view.company;
    await this.bundles.seal(led.id, async out =>
      sealBundle({
        dump: createReadStream(file), id: led.id, company, dumpedAt: new Date(dump.data.at), now: this.now(), reason: 'fork', migrations: dump.data.migrations,
        secrets: opts.secrets(), recipients: [...view.recipients, (await opts.age()).recipient], recovery: view.recovery?.recipient ?? null,
        recoveryLink: view.recovery?.link ?? null, key: opts.key, held, out,
      }),
    );
    this.lastFailure = null;
    this.keep({ ...led, sealed: true, failed: null });
    return true;
  }

  /* The bundle goes to the keeper that leads. Taken and recorded there, the dump goes here. */
  private async give(led: LedState): Promise<void> {
    const leader = this.opts.leader();
    const stored = this.bundles.open(led.id);
    if (!leader || !stored) {
      this.step = 'server';
      return;
    }
    this.step = 'send';
    const status = await this.opts.put(leader.networkId, led.id, stored).catch(() => null);
    if (status !== 200 && status !== 201) {
      this.step = 'retry';
      return;
    }
    this.clearDump(led.id);
    this.keep({ ...led, recorded: true });
    this.opts.log('What this machine did while it led is saved with the company server.');
  }
}
