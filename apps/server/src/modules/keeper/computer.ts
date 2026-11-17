import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UUID } from '../../net/proxy.js';
import { readGrant, type Grant } from '../computer/grant.js';
import { Hourly, readJson, reasonOf, writePrivately } from './machine-keys.js';

/* How often the keeper asks while its machine's access is open or a command of it is out, and how often otherwise. */
const OPEN_EVERY_MS = 2_000;
const CLOSED_EVERY_MS = 15_000;
/* With no answer of the app for this long, since the start or the last one, the machine closes: it cannot hear a close. */
const DEAF_MS = 60_000;
/* How long one request may take. */
export const ASK_MS = 10_000;
/* The updater is alive when it touched its file within this, as the app took it before. */
const ALIVE_MS = 30_000;
/* The grant the keeper holds, and the ones that ended, each until its own end, so none opens the machine twice. */
export const GRANTS_FILE = 'grants.json';
const LEGACY_FILE = 'computer.legacy.json';
/* As many held commands as one ask names. */
const HELD_MOST = 8;

/* The keeper's request to the app that leads: its own app's, or through its peer link. */
export type ComputerAsk = (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;

export type ComputerCarrierOptions = {
  /* The folder the keeper shares with its updater, and the keeper's own. */
  controlDir: string;
  dir: string;
  /* This machine's id in the company's network, which a grant names. */
  machine: string;
  ask: ComputerAsk;
  /* The key of the machine's owner that the keeper holds, if any. */
  pin: () => string | null;
  /* The server's own keeper alone: with no key it takes its app's word, whose database is its own. */
  trustApp: boolean;
  log: (line: string) => void;
  now?: () => Date;
  openEveryMs?: number;
  closedEveryMs?: number;
  deafMs?: number;
  askMs?: number;
};

const SignedGrant = z.object({ payload: z.string().min(1).max(4096), signature: z.string().min(1).max(4096) });
const Answer = z.object({
  access: z.object({ untilSec: z.number().int().positive(), until: z.string(), grant: SignedGrant.nullable() }).nullable(),
  runs: z.array(z.object({ id: z.string().regex(UUID), command: z.string().min(1), timeout: z.number().int().positive() })).max(HELD_MOST),
  /* The commands this keeper named that are no longer out with it. An app from before it said so names none. */
  forget: z.array(z.string().regex(UUID)).max(HELD_MOST).default([]),
});
const GRANT_NONCE = /^[A-Za-z0-9_-]{22}$/;
/* The nonce a grant carries, when it carries one as grants do. */
function nonceOf(grant: { payload: string } | null): string | null {
  try {
    const nonce = grant ? (JSON.parse(grant.payload) as { nonce?: unknown }).nonce : null;
    return typeof nonce === 'string' && GRANT_NONCE.test(nonce) ? nonce : null;
  } catch {
    return null;
  }
}

/* since: the second this record was started anew after one that could not be read. What was spent before is not known
   then, so no grant signed before that second is taken. */
const Grants = z.object({ held: SignedGrant.nullable(), spent: z.array(z.object({ nonce: z.string(), until: z.number() })), since: z.number().optional() });
type Grants = z.infer<typeof Grants>;
const Out = z.object({ exit: z.number().int().min(0).max(255), output: z.string() });

type Settings = { untilSec: number | null; until: string | null; asked: null; by: 'keeper' };
const CLOSED: Settings = { untilSec: null, until: null, asked: null, by: 'keeper' };

/* Carries a machine's computer access between the app that leads and the machine's own updater. It asks the app for the
   access and the next command, writes them where the updater reads them, and brings each answer back. The app never
   calls it. What opens the machine is its owner's signed word, checked here against the key this keeper holds: an app
   that says open without it opens nothing. Anything unclear closes. */
export class ComputerCarrier {
  private readonly now: () => Date;
  private readonly hourly = new Hourly();
  private readonly stopping = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private round: Promise<number> | null = null;
  private heardAt = 0;
  private wasOpen = false;
  private prepared = false;
  /* The app said open with a grant this keeper did not take: said back to it at the next ask, once. */
  /* The grant the app gave last that opened nothing here, by its nonce; '1' for an open answer with no grant to name. */
  private refusedGrant: string | null = null;
  /* The numbers of grants that ended while the keeper's folder took no write: kept here until it does. */
  private readonly spentUnwritten = new Map<string, number>();
  /* What the keeper last decided of its grants, for a round in which the file cannot be read. */
  private decided: Grants | null = null;

  constructor(private readonly opts: ComputerCarrierOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  private file(name: string): string {
    return join(this.opts.controlDir, name);
  }

  /* What an app from before access was per machine wrote goes aside, by one rename and never over one set aside
     before, and the machine is closed until the app that leads has taken it over. What a keeper wrote stays, so a
     restart stops no command; the minute without an answer counts from here. */
  prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    this.heardAt = this.now().getTime();
    try {
      mkdirSync(this.file('computer'), { recursive: true });
      const said = readJson(this.file('computer.json')) as { by?: unknown } | null;
      if (said && said.by === undefined && !existsSync(this.file(LEGACY_FILE))) renameSync(this.file('computer.json'), this.file(LEGACY_FILE));
      if (!said || said.by === undefined) this.write(CLOSED);
    } catch (err) {
      this.opts.log(`Could not prepare the control folder for computer access: ${reasonOf(err)}`);
    }
  }

  start(): void {
    this.prepare();
    this.again(0);
  }

  private again(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick().then(next => this.again(next)), ms);
    this.timer.unref();
  }

  /* One round, and the pause before the next. Rounds never overlap. */
  tick(): Promise<number> {
    this.round ??= this.oneRound().finally(() => (this.round = null));
    return this.round;
  }

  /* Ends the round in flight, writes nothing of it, and leaves the machine closed: a keeper that asks no more cannot
     hear a close. */
  async stop(): Promise<void> {
    this.stopping.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.round?.catch(() => undefined);
    this.write(CLOSED, true);
  }

  private async oneRound(): Promise<number> {
    try {
      await this.takeAccess();
      await this.bringAnswers();
    } catch (err) {
      this.sayHourly('round', `Computer access could not be carried this round: ${reasonOf(err)}`);
    }
    const busy = this.wasOpen || this.commandFiles().length > 0;
    return busy ? (this.opts.openEveryMs ?? OPEN_EVERY_MS) : (this.opts.closedEveryMs ?? CLOSED_EVERY_MS);
  }

  private sayHourly(what: string, line: string): void {
    if (this.hourly.due(what)) this.opts.log(line);
  }

  private bounded(): AbortSignal {
    return AbortSignal.any([this.stopping.signal, AbortSignal.timeout(this.opts.askMs ?? ASK_MS)]);
  }

  private updaterAlive(): boolean {
    try {
      return Date.now() - statSync(this.file('alive')).mtimeMs < ALIVE_MS;
    } catch {
      return false;
    }
  }

  /* The names in the commands' folder. */
  private names(): string[] {
    try {
      return readdirSync(this.file('computer'));
    } catch {
      return [];
    }
  }

  /* The commands this keeper holds: the ones whose file its updater still reads. */
  private commandFiles(): string[] {
    return this.names().flatMap(name => (name.endsWith('.json') && UUID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : []));
  }

  /* Written whole and then moved, so the updater never reads half of it, and only when it says something new. */
  private write(settings: Settings, evenStopped = false): void {
    if (this.stopped && !evenStopped) return;
    const text = JSON.stringify(settings);
    try {
      if (existsSync(this.file('computer.json')) && readFileSync(this.file('computer.json'), 'utf8') === text) return;
      writeFileSync(this.file('computer.json.new'), text);
      renameSync(this.file('computer.json.new'), this.file('computer.json'));
    } catch (err) {
      this.sayHourly('write', `Could not write this machine's computer access for its updater: ${reasonOf(err)}`);
    }
  }

  /* What the keeper wrote down of its grants: nothing yet when there is no file, and null when a file is there that
     cannot be read, which is no reason to forget what it said. */
  private grants(): Grants | null {
    const file = join(this.opts.dir, GRANTS_FILE);
    if (!existsSync(file)) return { held: null, spent: [] };
    try {
      const kept = Grants.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      return kept.success ? kept.data : null;
    } catch {
      return null;
    }
  }

  /* Whether it was kept. Without it nothing opens: a grant that could not be written down as held could not be told
     from a spent one after a restart. */
  private keep(grants: Grants): boolean {
    try {
      writePrivately(join(this.opts.dir, GRANTS_FILE), JSON.stringify(grants));
      this.spentUnwritten.clear();
      return true;
    } catch (err) {
      for (const one of grants.spent) this.spentUnwritten.set(one.nonce, one.until);
      this.unkept(reasonOf(err));
      return false;
    }
  }

  /* A record that cannot be read is no reason to keep the machine closed for good, nor to forget that grants were
     spent: the new one says from when it counts. */
  private startAnew(nowS: number): Grants {
    this.opts.log("The keeper's record of grants cannot be read. It starts a new one, and takes only what the machine's owner signs from now on.");
    return { held: null, spent: [], since: nowS };
  }

  private unkept(why: string): void {
    this.sayHourly('grants', `The keeper could not keep its record of grants, so this machine's computer stays closed: ${why}`);
  }

  /* A grant that ended goes to the spent ones, each kept until its own end. */
  private spend(grants: Grants, grant: Grant | null, nowS: number): Grants {
    const facts = grant ? (JSON.parse(grant.payload) as { nonce?: unknown; until?: unknown }) : null;
    const more = facts && typeof facts.nonce === 'string' && typeof facts.until === 'number' ? [{ nonce: facts.nonce, until: facts.until }] : [];
    const spent = [...grants.spent.filter(one => !more.some(m => m.nonce === one.nonce)), ...more].filter(one => one.until > nowS);
    return { ...grants, held: null, spent };
  }

  /* Until when the app's answer opens this machine, in seconds, or null. With a key held, only its owner's grant for
     this machine opens it, once, and no later than the grant says; what the keeper holds and what it spent is written
     down before the access changes, and while that cannot be written the machine is closed. Without a key, the
     server's own keeper takes its app's word, and any other stays closed. */
  private openUntil(access: z.infer<typeof Answer>['access']): number | null {
    const nowS = Math.floor(this.now().getTime() / 1000);
    const pin = this.opts.pin();
    this.refusedGrant = null;
    if (!pin) return this.opts.trustApp && access && access.untilSec > nowS ? access.untilSec : null;
    const read = this.grants();
    /* What it holds and spent: as written, or as it last decided when the file cannot be read. With neither, what was
       spent is not known any more: a new record starts, which takes no grant signed before this moment, so a grant
       that ended before cannot open the machine again, and one its owner signs now can. */
    const known = read ?? this.decided ?? this.startAnew(nowS);
    const before: Grants = { ...known, spent: [...known.spent, ...[...this.spentUnwritten].filter(([nonce]) => !known.spent.some(one => one.nonce === nonce)).map(([nonce, until]) => ({ nonce, until }))] };
    const sent = access?.grant ?? null;
    const same = before.held !== null && sent !== null && before.held.payload === sent.payload && before.held.signature === sent.signature;
    let after: Grants = same ? { ...before, spent: before.spent.filter(one => one.until > nowS) } : this.spend(before, before.held, nowS);
    const read_ = sent ? readGrant(sent, pin, this.opts.machine, nowS) : null;
    const facts = read_ && read_.at >= (before.since ?? 0) ? read_ : null;
    let until: number | null = null;
    if (access && sent && facts && !after.spent.some(one => one.nonce === facts.nonce)) {
      after = { ...after, held: sent };
      until = Math.min(facts.until, access.untilSec);
    } else {
      /* What it held ended with this answer, though the app sent it again. */
      if (same) after = this.spend(after, before.held, nowS);
      if (access) {
        this.refusedGrant = nonceOf(sent) ?? '1';
        this.sayHourly('grant', "The company server says this machine's computer access is open, with no grant of its owner that this machine's keeper takes. It stays closed.");
      }
    }
    const kept = JSON.stringify(after) === JSON.stringify(read) || this.keep(after);
    /* A grant that could not be written down as held is not held, and is not spent either: it opens once it can be. */
    this.decided = kept ? after : { ...after, held: null };
    if (!kept) return null;
    return until !== null && until > nowS ? until : null;
  }

  private async takeAccess(): Promise<void> {
    const held = this.commandFiles().slice(0, HELD_MOST);
    /* The app hears once that the grant it gave opened nothing here, so nobody is shown an open machine that is closed. */
    const refused = this.refusedGrant ? `&refused=${this.refusedGrant}` : '';
    this.refusedGrant = null;
    const path = `/api/network/computer?updater=${this.updaterAlive() ? 1 : 0}&held=${held.join(',')}${refused}`;
    const res = await this.opts.ask('GET', path, undefined, this.bounded()).catch((err: unknown) => ({ status: 0, body: reasonOf(err) }));
    if (this.stopped) return;
    const said = res.status === 200 ? Answer.safeParse(res.body) : null;
    if (said?.success) {
      this.heardAt = this.now().getTime();
      const until = this.openUntil(said.data.access);
      this.wasOpen = until !== null;
      this.write(until === null ? CLOSED : { untilSec: until, until: new Date(until * 1000).toISOString(), asked: null, by: 'keeper' });
      for (const id of said.data.forget) this.letGo(id);
      for (const run of said.data.runs) this.writeRun(run);
      return;
    }
    if (res.status === 404) {
      /* An app from before access was per machine. */
      this.heardAt = this.now().getTime();
      this.wasOpen = false;
      return this.write(CLOSED);
    }
    this.sayHourly('ask', `Could not ask the company server for this machine's computer access: ${res.status === 0 ? String(res.body) : `it answered ${res.status}`}.`);
    if (this.now().getTime() - this.heardAt >= (this.opts.deafMs ?? DEAF_MS)) {
      this.wasOpen = false;
      this.write(CLOSED);
    }
  }

  /* A command is written once: never again while its file, its updater's mark or its answer is there. On a machine that
     is closed its updater answers it by itself, with the code for that. */
  private writeRun(run: { id: string; command: string; timeout: number }): void {
    if (this.stopped) return;
    const base = join(this.file('computer'), run.id);
    if ([`${base}.json`, `${base}.started`, `${base}.out.json`].some(existsSync)) return;
    writeFileSync(`${base}.json.new`, JSON.stringify(run));
    renameSync(`${base}.json.new`, `${base}.json`);
  }

  /* A command the app no longer has out with this keeper, or whose answer nobody can read: its files go. At its next
     look the updater clears its own mark of it and removes what is left of its container; one it still watches runs
     until its time is over or access closes, and its answer then goes nowhere. */
  private letGo(id: string): void {
    if (this.stopped) return;
    const base = join(this.file('computer'), id);
    rmSync(`${base}.json`, { force: true });
    rmSync(`${base}.out.json`, { force: true });
  }

  /* Each answer the updater wrote goes to the app, and its files go once the app took it or knows no such command. A
     command's file goes only so, or when the app says to let go of it: the updater answers only while it is there. */
  private async bringAnswers(): Promise<void> {
    for (const name of this.names()) {
      if (this.stopped) return;
      const id = name.endsWith('.out.json') ? name.slice(0, -'.out.json'.length) : '';
      if (!UUID.test(id)) continue;
      const base = join(this.file('computer'), id);
      const out = Out.safeParse(readJson(`${base}.out.json`));
      if (!out.success) {
        /* The updater moves an answer into place whole, so one that cannot be read never will be: it is let go of, and
           the app counts the command as lost. */
        this.sayHourly('answer', `The answer of command ${id} could not be read on this machine, so its outcome is unknown.`);
        this.letGo(id);
        continue;
      }
      const res = await this.opts.ask('POST', `/api/network/computer/${id}`, out.data, this.bounded()).catch(() => ({ status: 0, body: null }));
      if (res.status !== 204 && res.status !== 404) continue;
      rmSync(`${base}.json`, { force: true });
      rmSync(`${base}.out.json`, { force: true });
    }
  }
}
