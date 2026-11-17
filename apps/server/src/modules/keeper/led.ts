import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

/* A machine that led the company and follows another now holds a database nobody else has whole: what it did while it
   led, as far as the new leader lacks it. Before its copy is made again, its keeper saves that database: its updater
   dumps it, the keeper seals the dump as a backup of the company, signs it and gives it to the keeper that leads,
   which records it. Only then may the database be merged and, later, go. Each step is looked at first, so a keeper
   that starts again in the middle goes on. */

export const LED_FILE = 'led.json';
const EVERY_MS = 10_000;
/* A dump that failed is asked for again after this long. */
export const LED_RETRY_MS = 600_000;
const DUMP_FILE = 'dump.json';
const DUMPS_DIR = 'dumps';
const DATABASE = 'hornhoof';

/* id: the bundle's id. term: the number of the term the database led under. asked: when its dump was asked for last.
   sealed: the bundle lies in this keeper's own store. recorded: the keeper that leads took and recorded it. failed:
   why the updater could not dump, until it is asked again. */
const LedShape = z.object({ id: z.uuid(), term: z.number().int().min(0), asked: z.string().nullable(), sealed: z.boolean(), recorded: z.boolean(), failed: z.string().nullable(), at: z.string() });
type LedState = z.infer<typeof LedShape>;

/* What this keeper wrote down of saving the database that led; none when it wrote nothing, or nothing it can read. */
export function readLed(dir: string): LedState | null {
  try {
    return readNote(join(dir, LED_FILE), LedShape, 'saving the database that led');
  } catch {
    return null;
  }
}

export type LedSaverOptions = {
  /* The keeper's own folder, and the control folder it shares with its updater. */
  dir: string;
  controlDir: string;
  /* This machine's own database, the one that led. */
  sql: Sql;
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
  private failing = false;
  private readonly bundles: BundleStore;

  constructor(private readonly opts: LedSaverOptions) {
    this.led = readLed(opts.dir);
    this.bundles = new BundleStore(join(opts.dir, BUNDLES_DIR));
  }

  state(): LedState | null {
    return this.led;
  }

  /* The keeper that leads recorded the bundle: the database may be merged, and go once it is. */
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
  }

  /* One look at a time. A look that fails changes nothing but what it wrote down, and is said once an outage. */
  tick(): Promise<void> {
    this.working ??= this.look()
      .then(
        () => void (this.failing = false),
        (err: unknown) => {
          if (!this.failing) this.opts.log(`The keeper could not save what this machine did while it led: ${reasonOf(err)}`);
          this.failing = true;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private keep(led: LedState): LedState {
    writePrivately(join(this.opts.dir, LED_FILE), JSON.stringify(led));
    this.led = led;
    return led;
  }

  private async look(): Promise<void> {
    if (this.led?.recorded) return;
    const led = this.led ?? (await this.begin());
    if (!led) return;
    if (!led.sealed && !(await this.seal(led))) return;
    await this.give(this.led!);
  }

  /* Nothing reads from this database any more, and none of its commits waits for a copy: its slots go, and the copy
     it named. Then its dump is asked for, under a new id. */
  private async begin(): Promise<LedState | null> {
    const { sql } = this.opts;
    const [state] = (await sql.query<{ number: string }>(`SELECT term_number::text AS number FROM net_local.state s WHERE to_jsonb(s) ->> 'handed_lsn' IS NULL`)).rows;
    if (!state) return null;
    await dropSlots(sql);
    await waitForNoCopy(sql);
    const led = this.keep({ id: randomUUID(), term: Number(state.number), asked: null, sealed: false, recorded: false, failed: null, at: this.now().toISOString() });
    this.opts.log('This machine led the company before: what it did then is saved before its copy is made again.');
    return led;
  }

  /* The dump is asked of the updater, and sealed once it is there. True once the bundle lies in this keeper's store. */
  private async seal(led: LedState): Promise<boolean> {
    const { opts } = this;
    const dumps = join(opts.controlDir, DUMPS_DIR);
    const [file, said, failed, request] = [join(dumps, `${led.id}.sql.gz`), join(dumps, `${led.id}.json`), join(dumps, `${led.id}.failed`), join(opts.controlDir, DUMP_FILE)];
    if (this.bundles.has(led.id)) {
      this.keep({ ...led, sealed: true, failed: null });
      return true;
    }
    if (existsSync(failed)) {
      let why = '';
      try {
        why = readFileSync(failed, 'utf8').trim().slice(0, 200);
      } catch {
        /* Not readable: the line goes without it. */
      }
      rmSync(failed, { force: true });
      this.keep({ ...led, failed: why || 'The database could not be dumped.' });
      opts.log(`The updater could not dump the database this machine led with${why ? `: ${why}` : '.'}`);
      return false;
    }
    if (!existsSync(said) || !existsSync(file)) {
      /* Asked once, and again ten minutes after a dump that failed. */
      const asked = led.asked === null ? null : Date.parse(led.asked);
      const due = asked === null || (led.failed !== null && this.now().getTime() - asked >= LED_RETRY_MS);
      if (due && !existsSync(request)) {
        writePrivately(request, JSON.stringify({ id: led.id, database: DATABASE, reason: 'fork' }));
        this.keep({ ...led, asked: this.now().toISOString(), failed: asked === null ? null : led.failed });
      }
      return false;
    }
    const dump = z.object({ id: z.literal(led.id), reason: z.literal('fork'), at: z.string(), migrations: z.number().int().min(0) }).safeParse(JSON.parse(readFileSync(said, 'utf8')));
    const held = opts.held();
    const view = await opts.view();
    if (!dump.success) throw new Error('the dump the updater left says it is another one');
    if (!held || !view?.company) return false;
    mkdirSync(join(opts.dir, BUNDLES_DIR), { recursive: true, mode: 0o700 });
    const out = join(opts.dir, BUNDLES_DIR, `${led.id}.${randomBytes(6).toString('hex')}.part`);
    try {
      const sealed = await sealBundle({
        dump: createReadStream(file), id: led.id, company: view.company, dumpedAt: new Date(dump.data.at), now: this.now(), reason: 'fork', migrations: dump.data.migrations,
        secrets: opts.secrets(), recipients: [...view.recipients, (await opts.age()).recipient], recovery: view.recovery?.recipient ?? null, recoveryLink: view.recovery?.link ?? null,
        key: opts.key, held, out,
      });
      this.bundles.put(sealed.head, sealed.manifest, out);
    } catch (err) {
      rmSync(out, { force: true });
      throw err;
    }
    this.keep({ ...led, sealed: true, failed: null });
    return true;
  }

  /* The bundle goes to the keeper that leads. Taken and recorded there, the dump goes here. */
  private async give(led: LedState): Promise<void> {
    const leader = this.opts.leader();
    const stored = this.bundles.open(led.id);
    if (!leader || !stored) return;
    const status = await this.opts.put(leader.networkId, led.id, stored).catch(() => null);
    if (status !== 200 && status !== 201) return;
    const dumps = join(this.opts.controlDir, DUMPS_DIR);
    for (const end of ['.sql.gz', '.json']) rmSync(join(dumps, `${led.id}${end}`), { force: true });
    this.keep({ ...led, recorded: true });
    this.opts.log('What this machine did while it led is saved with the company server.');
  }
}
