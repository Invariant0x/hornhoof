import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { computerRuns, machineAccess, machines, people, personKeys, type MachineRole } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { askerOf, KEEPER_MARK } from '../network/via.js';
import { readGrant, type Grant } from './grant.js';
import { keyPrint } from './owner-key.js';

/* How long one click keeps access to a machine open where no grant says so: the server's own machine with no key. */
export const ACCESS_MS = 24 * 60 * 60 * 1000;
/* A command runs this many seconds unless the orchestrator gives its own time, never longer than the most. */
export const RUN_DEFAULT_S = 300;
export const RUN_MAX_S = 1800;
/* How long one tool call waits for a command's answer: under the minute Codex gives a tool. */
export const WAIT_MS = 45_000;
/* A machine is reachable when its keeper asked, with its updater alive, within this. */
export const SEEN_MS = 60_000;
/* Commands that ended, and ones that were lost, go after this long. */
export const RUN_KEEP_MS = 24 * 3_600_000;
/* A command its keeper took and does not hold this long after is lost: what it did is not known. */
export const HELD_GRACE_S = 30;
/* A command its keeper holds past the time it was given, and this much more, is lost all the same: its updater would
   have ended and answered it by then. */
export const SENT_GRACE_S = 300;
/* A command no keeper took within this was never run, and is not run later: whoever asked has moved on. */
export const WAITING_MS = 10 * 60_000;
/* How often the commands of long ago are cleared away. */
const CLEAR_EVERY_MS = 3_600_000;
/* The end of a command's output that is kept. */
export const OUTPUT_MAX = 30_000;
/* What an app from before access was per machine left in the control folder, set aside until this app leads. */
export const LEGACY_FILE = 'computer.legacy.json';
const POLL_MS = 250;
/* What a command that never ran answers, as the updater does for one on a closed computer. */
const CLOSED_EXIT = 126;

export type Asked = { reason: string; at: string };
/* A machine of the company that has the company's core, and so can have its computer opened. */
/* name: what it is called in the log and to the orchestrator. hostname: the name its computer told, or none, for a
   screen that names an unnamed machine in the reader's own language. */
export type AccessMachine = { id: string; networkId: string; name: string; hostname: string; personId: string; role: MachineRole | null; os: 'linux' | 'darwin' | null; data: boolean };
/* not_needed: the server's own machine while its keeper holds no key, which takes the app's word. held: the machine
   holds the key its owner has now. not_held: it holds none, or another, so nothing its owner signs opens it. */
export type KeyState = 'not_needed' | 'held' | 'not_held';
export type AccessState = { machine: AccessMachine; reachable: boolean; until: string | null; asked: Asked | null; key: KeyState };
export type AccessView = AccessState & { canOpen: boolean; canClose: boolean };
export type RunResult = { exit: number; output: string };
/* A command's answer, or that it still runs, that there is no such command, or that its machine's core lost it. */
export type Waited = RunResult | 'running' | 'gone' | 'lost';
/* forget: the commands the keeper named that are no longer out with it, whose files it lets go of. */
export type Taken = { access: { untilSec: number; until: string; grant: Grant | null } | null; runs: { id: string; command: string; timeout: number }[]; forget: string[] };

type Row = typeof machines.$inferSelect;
type Opener = Pick<Person, 'id' | 'companyId' | 'status' | 'scopeKind' | 'isOwner' | 'isCeoDelegate' | 'via'>;

/* People who see the whole company see each machine's access from their own screens: never the orchestrator acting for
   the CEO. */
export const canViewComputer = (me: { scopeKind: string; via?: string }): boolean => me.scopeKind === 'company' && !me.via;

/* A machine's owner opens it, on their own screen, and nobody else: not the CEO on another person's machine, and not
   the orchestrator acting for anyone. The server's own machine while it needs no key is the company's, as before
   machines had keys: the CEO, who owns it, or the CEO delegate opens it. */
export const canOpen = (me: Opener, machine: { personId: string }, key: KeyState): boolean =>
  !me.via && me.status === 'active' && (me.id === machine.personId || (key === 'not_needed' && actsAsCeo(me)));

/* Closing takes power away, so the CEO and the CEO delegate close any machine besides its owner. */
export const canClose = (me: Opener, machine: { personId: string }): boolean => !me.via && me.status === 'active' && (me.id === machine.personId || actsAsCeo(me));

/* What a line in the log says of the machine, when it is known. */
export const onMachine = (machine: string | null): Record<string, string> => (machine ? { machine } : {});
/* The name a line of the log keeps for a machine: the one its computer told. The server's own machine that told none is
   left unnamed there, and each screen names it in the reader's own language. */
export const logName = (machine: Pick<AccessMachine, 'hostname' | 'name' | 'data'>): string | null => machine.hostname || (machine.data ? null : machine.name);

const closedLine = (name: string): string => `Access to ${name} is closed.`;
const staleLine = (name: string): string => `${name} did not take this command in time, so it was not run.`;
const notOwner = (name: string) => new ApiError(403, 'forbidden', `Only the owner of ${name} opens access to it.`, 'not_machine_owner');
const noCore = () => new ApiError(404, 'not_found', "This machine has none of the company's core, so there is no access to open on it.", 'no_core');
const unreachable = (name: string) => new ApiError(409, 'conflict', `Hornhoof cannot reach ${name} now: its core has not answered for a minute.`, 'machine_unreachable');
const keyNotHeld = (name: string) =>
  new ApiError(409, 'conflict', `${name} does not hold your key yet. Run a new command from Connect a machine on it: it takes your key only from there.`, 'key_not_held');

const LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/* Ends the commands of machines whose access went: the ones nobody took never ran, and the ones a keeper took have an
   outcome nobody will hear of. The machines' rows are held by the caller. */
async function endRuns(tx: Db, machineIds: string[], names: Map<string, string>, now: Date, alsoSent: boolean): Promise<void> {
  for (const id of machineIds) {
    const waiting = and(eq(computerRuns.machineId, id), eq(computerRuns.state, 'waiting'));
    await tx.update(computerRuns).set({ state: 'done', exit: CLOSED_EXIT, output: closedLine(names.get(id) ?? 'this machine'), doneAt: now }).where(waiting);
    if (alsoSent) await tx.update(computerRuns).set({ state: 'lost', doneAt: now }).where(and(eq(computerRuns.machineId, id), eq(computerRuns.state, 'sent')));
  }
}

/* The nonce of a grant as it was signed; none for one that is no grant. */
function grantNonce(payload: string): string | null {
  try {
    const { nonce } = JSON.parse(payload) as { nonce?: unknown };
    return typeof nonce === 'string' ? nonce : null;
  } catch {
    return null;
  }
}

/* Disconnect's part for computer access, in its transaction, with the machines' rows held: their access goes with
   them, and their commands end. */
export async function dropAccess(tx: Db, machineIds: string[], now: Date): Promise<void> {
  if (machineIds.length === 0) return;
  const rows = await tx.select({ id: machines.id, hostname: machines.hostname }).from(machines).where(inArray(machines.id, machineIds));
  await tx.delete(machineAccess).where(inArray(machineAccess.machineId, machineIds));
  await endRuns(tx, machineIds, new Map(rows.map(row => [row.id, row.hostname || 'this machine'])), now, true);
}

/* Computer access to each machine of the company that has its core. The state is rows only this app writes while it
   leads; each machine's own keeper asks for it, hands the commands to its updater and brings the answers back. */
export class Computers {
  readonly waitMs: number;
  private readonly now: () => Date;
  private readonly seenAt = new Map<string, number>();
  private legacyDone = false;
  private clearedAt = 0;

  constructor(
    private readonly ctx: Pick<Ctx, 'db' | 'config' | 'log'>,
    opts: { now?: () => Date; waitMs?: number } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.waitMs = opts.waitMs ?? WAIT_MS;
  }

  private own(row: Pick<Row, 'networkId'>): boolean {
    return row.networkId !== null && row.networkId === this.ctx.config.machineId;
  }

  private nameOf(row: Pick<Row, 'hostname' | 'networkId' | 'id'>): string {
    return row.hostname || (this.own(row) ? 'the company server' : `machine ${row.id.slice(0, 8)}`);
  }

  private machineOf(row: Row): AccessMachine {
    const os = row.os === 'linux' || row.os === 'darwin' ? row.os : null;
    return { id: row.id, networkId: row.networkId!, name: this.nameOf(row), hostname: row.hostname, personId: row.personId, role: row.role, os, data: row.role === 'data' };
  }

  private keyOf(row: Pick<Row, 'networkId' | 'ownerPin'>, ownerKey: string | undefined): KeyState {
    if (!row.ownerPin) return this.own(row) ? 'not_needed' : 'not_held';
    return ownerKey !== undefined && keyPrint(ownerKey) === row.ownerPin ? 'held' : 'not_held';
  }

  private rows(companyId: string, db: Pick<Db, 'select'> = this.ctx.db): Promise<Row[]> {
    return db
      .select()
      .from(machines)
      .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt), isNotNull(machines.networkId)))
      .orderBy(asc(machines.createdAt), asc(machines.id));
  }

  /* The machines of the company that have its core. */
  async machines(companyId: string): Promise<AccessMachine[]> {
    return (await this.rows(companyId)).map(row => this.machineOf(row));
  }

  /* One of them by its id or by its name, whatever the case; left out, the machine this server runs on. */
  async find(companyId: string, nameOrId?: string): Promise<AccessMachine | 'none' | 'ambiguous'> {
    const all = await this.machines(companyId);
    if (nameOrId === undefined) return all.find(machine => machine.networkId === this.ctx.config.machineId) ?? 'none';
    const byId = all.find(machine => machine.id === nameOrId.toLowerCase());
    if (byId) return byId;
    const named = all.filter(machine => machine.name.toLowerCase() === nameOrId.toLowerCase());
    return named.length === 1 ? named[0]! : named.length > 1 ? 'ambiguous' : 'none';
  }

  /* A machine's keeper asked: with its updater alive, the machine is reachable for a while. */
  seen(machineId: string, updaterAlive: boolean): void {
    if (updaterAlive) this.seenAt.set(machineId, this.now().getTime());
    else this.seenAt.delete(machineId);
  }

  reachable(machineId: string): boolean {
    const at = this.seenAt.get(machineId);
    return at !== undefined && this.now().getTime() - at < SEEN_MS;
  }

  /* Until when the machine's access is open, or null when it is closed or its day is over. */
  async openUntil(machineId: string): Promise<string | null> {
    const [row] = await this.ctx.db.select(only(machineAccess, 'until')).from(machineAccess).where(eq(machineAccess.machineId, machineId));
    return row?.until && row.until > this.now() ? row.until.toISOString() : null;
  }

  /* Every machine with a core and its access, as it is for anyone. */
  async states(companyId: string): Promise<AccessState[]> {
    const rows = await this.rows(companyId);
    if (rows.length === 0) return [];
    const ids = rows.map(row => row.id);
    const access = new Map((await this.ctx.db.select().from(machineAccess).where(inArray(machineAccess.machineId, ids))).map(row => [row.machineId, row]));
    const owners = [...new Set(rows.map(row => row.personId))];
    const keys = new Map((await this.ctx.db.select({ personId: personKeys.personId, publicKey: personKeys.publicKey }).from(personKeys).where(inArray(personKeys.personId, owners))).map(row => [row.personId, row.publicKey]));
    const now = this.now();
    return rows.map(row => {
      const held = access.get(row.id);
      return {
        machine: this.machineOf(row),
        reachable: this.reachable(row.id),
        until: held?.until && held.until > now ? held.until.toISOString() : null,
        asked: held?.askedReason && held.askedAt ? { reason: held.askedReason, at: held.askedAt.toISOString() } : null,
        key: this.keyOf(row, keys.get(row.personId)),
      };
    });
  }

  /* The same as this person sees it: whether they may open or close each comes with it. */
  async views(me: Person): Promise<AccessView[]> {
    return (await this.states(me.companyId)).map(state => ({ ...state, canOpen: canOpen(me, state.machine, state.key), canClose: canClose(me, state.machine) }));
  }

  async view(me: Person, machineId: string): Promise<AccessView | null> {
    return (await this.views(me)).find(view => view.machine.id === machineId) ?? null;
  }

  /* The machine's row, held for the rest of the transaction, when it is a live machine of the company with a core. */
  private async held(tx: Db, companyId: string, machineId: string, strength: 'update' | 'share' = 'update'): Promise<Row | null> {
    const [row] = await tx.select().from(machines).where(and(eq(machines.id, machineId), eq(machines.companyId, companyId))).for(strength);
    return row && !row.revokedAt && row.networkId ? row : null;
  }

  /* The orchestrator's request for a machine, which its owner sees. */
  async ask(companyId: string, machineId: string, reason: string): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, companyId, machineId);
      if (!row) throw noCore();
      const asked = { askedReason: reason, askedAt: this.now() };
      await tx.insert(machineAccess).values({ machineId, companyId, ...asked }).onConflictDoUpdate({ target: machineAccess.machineId, set: asked });
    });
  }

  /* Until when the opener's word opens the machine: where the machine holds a key, or is not the server's own, only
     what its owner signed with that key, which the machine's keeper checks again by itself. */
  private async untilOf(tx: Db, me: Opener, row: Row, grant: Grant | undefined, now: Date): Promise<{ until: Date; grant: Grant | null }> {
    if (!row.ownerPin && this.own(row)) return { until: new Date(now.getTime() + ACCESS_MS), grant: null };
    const name = this.nameOf(row);
    if (!grant) throw new ApiError(400, 'validation', `Opening ${name} takes its owner's signature, and this request brought none.`, 'grant_needed');
    const [mine] = await tx.select(only(personKeys, 'publicKey')).from(personKeys).where(eq(personKeys.personId, me.id));
    if (!mine) throw new ApiError(409, 'conflict', 'You have no key yet. Get a command under Connect a machine: Hornhoof makes your key then.', 'no_key');
    const facts = readGrant(grant, mine.publicKey, row.networkId!, Math.floor(now.getTime() / 1000));
    if (!facts) throw new ApiError(400, 'validation', `This is no signature of yours that opens ${name} now.`, 'bad_grant');
    if (keyPrint(mine.publicKey) !== row.ownerPin) throw keyNotHeld(name);
    return { until: new Date(facts.until * 1000), grant };
  }

  /* Opens the machine for its owner and answers what the orchestrator had asked it for. Everything is looked at again
     inside one transaction, under the rows Disable and Disconnect take, in their order: the person, then the machine. */
  async open(me: Person, machineId: string, grant?: Grant): Promise<{ machine: AccessMachine; until: string; asked: Asked | null }> {
    return this.ctx.db.transaction(async tx => {
      const [person] = await tx.select().from(people).where(eq(people.id, me.id)).for('share');
      const row = await this.held(tx, me.companyId, machineId);
      if (!row) throw noCore();
      const machine = this.machineOf(row);
      const [ownerKey] = await tx.select(only(personKeys, 'publicKey')).from(personKeys).where(eq(personKeys.personId, row.personId));
      const opener = person ? { ...person, via: me.via } : null;
      if (!opener || !canOpen(opener, machine, this.keyOf(row, ownerKey?.publicKey))) throw notOwner(machine.name);
      if (!this.reachable(machineId)) throw unreachable(machine.name);
      const now = this.now();
      const opened = await this.untilOf(tx, opener, row, grant, now);
      const [before] = await tx.select().from(machineAccess).where(eq(machineAccess.machineId, machineId)).for('update');
      const set = { until: opened.until, grant: opened.grant, openedBy: me.id, openedAt: now, askedReason: null, askedAt: null };
      await tx.insert(machineAccess).values({ machineId, companyId: me.companyId, ...set }).onConflictDoUpdate({ target: machineAccess.machineId, set });
      const asked = before?.askedReason && before.askedAt ? { reason: before.askedReason, at: before.askedAt.toISOString() } : null;
      return { machine, until: opened.until.toISOString(), asked };
    });
  }

  /* Takes the access away, and with it the commands no keeper took yet. One a keeper took is stopped by its updater,
     which hears of the close from its keeper. */
  async close(me: Person, machineId: string): Promise<AccessMachine> {
    return this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, me.companyId, machineId);
      if (!row) throw noCore();
      const machine = this.machineOf(row);
      if (!canClose(me, machine)) throw new ApiError(403, 'forbidden', `Only the owner of ${machine.name}, the CEO or the CEO delegate closes access to it.`, 'not_machine_owner');
      const now = this.now();
      await tx.update(machineAccess).set({ until: null, grant: null }).where(eq(machineAccess.machineId, machineId));
      await endRuns(tx, [machineId], new Map([[machineId, machine.name]]), now, false);
      return machine;
    });
  }

  /* Takes the orchestrator's request away; null when there was none. */
  async decline(me: Person, machineId: string): Promise<AccessMachine | null> {
    return this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, me.companyId, machineId);
      if (!row) throw noCore();
      const machine = this.machineOf(row);
      const [ownerKey] = await tx.select(only(personKeys, 'publicKey')).from(personKeys).where(eq(personKeys.personId, row.personId));
      if (!canOpen(me, machine, this.keyOf(row, ownerKey?.publicKey))) throw notOwner(machine.name);
      const cleared = await tx.update(machineAccess).set({ askedReason: null, askedAt: null }).where(and(eq(machineAccess.machineId, machineId), isNotNull(machineAccess.askedAt))).returning({ id: machineAccess.machineId });
      return cleared.length > 0 ? machine : null;
    });
  }

  /* A command for the machine, which its keeper takes while its access is open: its id, or why there is none. */
  async start(job: { id: string; agentId: string; companyId: string }, machineId: string, command: string, timeoutS: number): Promise<{ id: string } | 'closed' | 'none'> {
    return this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, job.companyId, machineId, 'share');
      if (!row) return 'none';
      const [access] = await tx.select(only(machineAccess, 'until')).from(machineAccess).where(eq(machineAccess.machineId, machineId));
      if (!access?.until || access.until <= this.now()) return 'closed';
      const [run] = await tx.insert(computerRuns).values({ companyId: job.companyId, machineId, jobId: job.id, agentId: job.agentId, command, timeoutS }).returning({ id: computerRuns.id });
      return { id: run!.id };
    });
  }

  /* Waits a while for the command's answer. One that no keeper took in time is ended here too, so whoever asked hears
     that it was not run. */
  async wait(runId: string, companyId: string, ms = this.waitMs): Promise<Waited> {
    const end = Date.now() + ms;
    const mine = and(eq(computerRuns.id, runId), eq(computerRuns.companyId, companyId));
    const read = () => this.ctx.db.select({ state: computerRuns.state, machineId: computerRuns.machineId, createdAt: computerRuns.createdAt }).from(computerRuns).where(mine);
    for (;;) {
      let [run] = await read();
      /* One that waited long is given up when it was its keeper that did not come for it, and read again. */
      if (run?.state === 'waiting' && this.now().getTime() - run.createdAt.getTime() >= WAITING_MS) {
        await this.endStale(run.machineId);
        [run] = await read();
      }
      if (!run) return 'gone';
      if (run.state === 'done') {
        const [done] = await this.ctx.db.select({ exit: computerRuns.exit, output: computerRuns.output }).from(computerRuns).where(mine);
        return { exit: done?.exit ?? -1, output: done?.output ?? '' };
      } else if (run.state === 'lost') return 'lost';
      else if (Date.now() >= end) return 'running';
      else await sleep(POLL_MS);
    }
  }

  /* Ends the commands of a machine that waited too long for its keeper: they were never run, and are not run later. A
     command also waits its turn behind one that is out, since a machine runs one at a time, and that wait is no keeper's
     fault: nothing is given up while a command of the machine is out, nor until that long after the last one its
     keeper took ended. One given up here was never taken, so it puts off none behind it. */
  private async endStale(machineId: string, tx: Db = this.ctx.db, known?: Pick<Row, 'hostname' | 'networkId' | 'id'>): Promise<void> {
    const now = this.now();
    const since = new Date(now.getTime() - WAITING_MS);
    const [row] = known ? [known] : await tx.select({ id: machines.id, hostname: machines.hostname, networkId: machines.networkId }).from(machines).where(eq(machines.id, machineId));
    const taken = alias(computerRuns, 'taken');
    const inTheWay = tx.select(idOnly(taken)).from(taken).where(and(eq(taken.machineId, machineId), or(eq(taken.state, 'sent'), and(isNotNull(taken.sentAt), gt(taken.doneAt, since)))));
    await tx
      .update(computerRuns)
      .set({ state: 'done', exit: CLOSED_EXIT, output: staleLine(row ? this.nameOf(row) : 'The machine'), doneAt: now })
      .where(and(eq(computerRuns.machineId, machineId), eq(computerRuns.state, 'waiting'), lt(computerRuns.createdAt, new Date(since.getTime() + 1)), notExists(inTheWay)));
  }

  /* The machine a command is for, for what the orchestrator is told of it. */
  async machineOfRun(runId: string, companyId: string): Promise<{ id: string; name: string } | null> {
    const [found] = await this.ctx.db
      .select({ id: machines.id, hostname: machines.hostname, networkId: machines.networkId })
      .from(computerRuns)
      .innerJoin(machines, eq(machines.id, computerRuns.machineId))
      .where(and(eq(computerRuns.id, runId), eq(computerRuns.companyId, companyId)));
    return found ? { id: found.id, name: this.nameOf(found) } : null;
  }

  /* What a machine's keeper takes when it asks: its access, and its next command while that is open. The keeper names
     the commands it still holds: one it took and no longer holds, a while after, is lost, and so is one it holds long
     past the time the command was given; none is ever sent twice, and the keeper is told which of those it named are
     no longer out, to let go of them. A command nobody took in time is ended unrun. A machine gets its next command
     only once none of its is out, as its updater runs one at a time. */
  async take(machineId: string, held: string[]): Promise<Taken> {
    return this.ctx.db.transaction(async tx => {
      const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update');
      if (!row || row.revokedAt || !row.networkId) return { access: null, runs: [], forget: held };
      const now = this.now();
      const out = await tx.select({ id: computerRuns.id, sentAt: computerRuns.sentAt, timeoutS: computerRuns.timeoutS }).from(computerRuns).where(and(eq(computerRuns.machineId, machineId), eq(computerRuns.state, 'sent')));
      const since = (run: (typeof out)[number]) => (run.sentAt ? now.getTime() - run.sentAt.getTime() : 0);
      const lost = out.filter(run => (held.includes(run.id) ? since(run) >= (run.timeoutS + SENT_GRACE_S) * 1000 : since(run) >= HELD_GRACE_S * 1000)).map(run => run.id);
      if (lost.length) await tx.update(computerRuns).set({ state: 'lost', doneAt: now }).where(inArray(computerRuns.id, lost));
      const stillOut = out.filter(run => !lost.includes(run.id)).map(run => run.id);
      const forget = held.filter(id => !stillOut.includes(id));
      if (now.getTime() - this.clearedAt >= CLEAR_EVERY_MS) {
        this.clearedAt = now.getTime();
        await tx.delete(computerRuns).where(and(eq(computerRuns.companyId, row.companyId), inArray(computerRuns.state, ['done', 'lost']), lt(computerRuns.doneAt, new Date(now.getTime() - RUN_KEEP_MS))));
      }
      await this.endStale(machineId, tx, row);
      const [access] = await tx.select().from(machineAccess).where(eq(machineAccess.machineId, machineId)).for('update');
      if (!access?.until || access.until <= now) {
        await endRuns(tx, [machineId], new Map([[machineId, this.nameOf(row)]]), now, false);
        return { access: null, runs: [], forget };
      }
      const opened = { untilSec: Math.floor(access.until.getTime() / 1000), until: access.until.toISOString(), grant: access.grant };
      if (stillOut.length > 0) return { access: opened, runs: [], forget };
      const [next] = await tx.select().from(computerRuns).where(and(eq(computerRuns.machineId, machineId), eq(computerRuns.state, 'waiting'))).orderBy(asc(computerRuns.createdAt), asc(computerRuns.id)).limit(1);
      if (!next) return { access: opened, runs: [], forget };
      await tx.update(computerRuns).set({ state: 'sent', sentAt: now }).where(eq(computerRuns.id, next.id));
      return { access: opened, runs: [{ id: next.id, command: next.command, timeout: next.timeoutS }], forget };
    });
  }

  /* The machine's keeper did not take the grant the app gave it: its clock is off, or it does not hold the key the app
     thinks it holds. The machine is closed there whatever the row says, so the row says so too, and nobody is shown an
     open machine that runs nothing. nonce: the grant the keeper means; one its owner signed since is another grant,
     and stays. The machine, when that changed anything. */
  async refused(machineId: string, nonce: string | null = null): Promise<AccessMachine | null> {
    return this.ctx.db.transaction(async tx => {
      const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update');
      if (!row || row.revokedAt || !row.networkId) return null;
      const now = this.now();
      if (nonce !== null) {
        const [open] = await tx.select(only(machineAccess, 'grant')).from(machineAccess).where(eq(machineAccess.machineId, machineId)).for('update');
        if (!open?.grant || grantNonce(open.grant.payload) !== nonce) return null;
      }
      const closed = await tx.update(machineAccess).set({ until: null, grant: null }).where(and(eq(machineAccess.machineId, machineId), isNotNull(machineAccess.grant), gt(machineAccess.until, now))).returning({ id: machineAccess.machineId });
      if (closed.length === 0) return null;
      const machine = this.machineOf(row);
      await endRuns(tx, [machineId], new Map([[machineId, machine.name]]), now, false);
      return machine;
    });
  }

  /* The answer of a command the machine's keeper took; false when it took no such command, or answered it already. */
  async answer(machineId: string, runId: string, result: RunResult): Promise<boolean> {
    return this.ctx.db.transaction(async tx => {
      await tx.select(idOnly(machines)).from(machines).where(eq(machines.id, machineId)).for('update');
      const done = await tx
        .update(computerRuns)
        .set({ state: 'done', exit: result.exit, output: result.output.slice(-OUTPUT_MAX), doneAt: this.now() })
        .where(and(eq(computerRuns.id, runId), eq(computerRuns.machineId, machineId), eq(computerRuns.state, 'sent')))
        .returning({ id: computerRuns.id });
      return done.length > 0;
    });
  }

  /* A new build leads the company, by its data keeper's report: no owner could close a machine while the leader
     changed, so every other machine's access closes, and its commands nobody took end. */
  async newBuild(tx: Db, serverMachineId: string): Promise<void> {
    const [mine] = await tx.select(only(machines, 'companyId')).from(machines).where(eq(machines.id, serverMachineId));
    if (!mine) return;
    const others = (await this.rows(mine.companyId, tx)).filter(row => row.id !== serverMachineId);
    if (others.length === 0) return;
    const ids = others.map(row => row.id);
    await tx.update(machineAccess).set({ until: null, grant: null }).where(and(inArray(machineAccess.machineId, ids), ne(machineAccess.machineId, serverMachineId)));
    await endRuns(tx, ids, new Map(others.map(row => [row.id, this.nameOf(row)])), this.now(), false);
  }

  /* An app from before access was per machine wrote the server's own access into the control folder. That file is set
     aside at start, by one rename and never over one set aside before, for the import below. */
  moveLegacy(controlDir: string): void {
    const file = join(controlDir, 'computer.json');
    const aside = join(controlDir, LEGACY_FILE);
    try {
      const said = JSON.parse(readFileSync(file, 'utf8')) as { by?: unknown };
      if (said.by === undefined && !existsSync(aside)) renameSync(file, aside);
    } catch {
      /* No such file, or the keeper moved it first. */
    }
    /* With nothing set aside there is nothing to take over. */
    this.legacyDone = !existsSync(aside);
  }

  /* While this app leads: what the file set aside said becomes the row of the server's own machine, once that machine
     has a row, and the file goes. It never writes over a row that is there: whatever was decided since the file was
     written stands, so a file of before that turns up later opens nothing. Until it is done the access of the server's
     own machine is not served. Whether it is done: false while the server's own machine has no row yet, to be tried
     again. */
  async importLegacy(controlDir: string): Promise<boolean> {
    if (this.legacyDone) return true;
    const aside = join(controlDir, LEGACY_FILE);
    const { machineId } = this.ctx.config;
    /* No file, or a server from before machines had ids, which has no machine of its own to open. */
    if (!machineId || !existsSync(aside)) return (this.legacyDone = true);
    const [mine] = await this.ctx.db.select().from(machines).where(and(eq(machines.networkId, machineId), isNull(machines.revokedAt)));
    if (!mine) return false;
    const said = JSON.parse(readFileSync(aside, 'utf8')) as { untilSec?: unknown; asked?: { reason?: unknown; at?: unknown } | null };
    const now = this.now();
    const until = typeof said.untilSec === 'number' && said.untilSec * 1000 > now.getTime() ? new Date(said.untilSec * 1000) : null;
    const asked = said.asked && typeof said.asked.reason === 'string' && typeof said.asked.at === 'string' ? { askedReason: said.asked.reason.slice(0, 500), askedAt: new Date(said.asked.at) } : { askedReason: null, askedAt: null };
    const taken = await this.ctx.db.transaction(async tx => {
      await tx.select(idOnly(machines)).from(machines).where(eq(machines.id, mine.id)).for('update');
      const row = { machineId: mine.id, companyId: mine.companyId, until, grant: null, openedBy: until ? mine.personId : null, openedAt: until ? now : null, ...asked };
      return (await tx.insert(machineAccess).values(row).onConflictDoNothing().returning({ id: machineAccess.machineId })).length > 0;
    });
    rmSync(aside, { force: true });
    this.ctx.log.info(taken ? `Took over the server's computer access as the build before left it: ${until ? `open until ${until.toISOString()}` : 'closed'}.` : "Left the server's computer access as it is: what the build before wrote is older than it.");
    return (this.legacyDone = true);
  }

  ready(): boolean {
    return this.legacyDone;
  }

  /* Whether this machine's access is served yet. Only the server's own machine waits for what an app from before left
     of it: every other machine of the company has nothing to take over, and is served whatever becomes of that. */
  async served(machineId: string): Promise<boolean> {
    if (this.legacyDone) return true;
    const [row] = await this.ctx.db.select(only(machines, 'networkId')).from(machines).where(eq(machines.id, machineId));
    return !row || !this.own(row);
  }

  /* The machine a person sits at: a request to localhost that did not come over the link came through the front door
     of the machine it names, a worker's when the peer door named one, else the server's own. Sitting there gives no
     right: opening still takes the owner's session. */
  async here(req: FastifyRequest, companyId: string): Promise<AccessMachine | null> {
    const forwarded = req.headers['x-forwarded-host'];
    if (!LOCALHOST.test(req.headers.host ?? '') || (forwarded !== undefined && !LOCALHOST.test(String(forwarded))) || req.overLink) return null;
    const asker = await askerOf(req, this.ctx.config);
    const all = await this.machines(companyId);
    if (asker && !asker.own) return req.headers[KEEPER_MARK] === '1' ? null : (all.find(machine => machine.id === asker.machine) ?? null);
    return all.find(machine => machine.networkId === this.ctx.config.machineId) ?? null;
  }
}
