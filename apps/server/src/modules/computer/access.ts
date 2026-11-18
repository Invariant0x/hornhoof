import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, lt, notExists, notInArray, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agentInbox, agents, jobs, computerRuns, machineAccess, machines, people, tasks, type MachineRole } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { askerOf, KEEPER_MARK } from '../network/via.js';
import { taskByRef } from '../tasks/lookup.js';
import { CLOSED } from '../tasks/state.js';

type AgentKind = (typeof agents.$inferSelect)['kind'];
type Delegation = { allAgents: true } | { employee: string; task: string | number };
type Access = Pick<typeof machineAccess.$inferSelect, 'scope' | 'employees'>;
type RunJob = { id: string; agentId: string; companyId: string };

const orchestratorOnly = (): Access => ({ scope: 'orchestrator', employees: [] });
const isEmployee = (kind: AgentKind): boolean => kind === 'head' || kind === 'worker';

type RunAgent = { id: string; kind: AgentKind; taskId: string | null; jobId: string | null };

async function allows(tx: Db, companyId: string, access: Access, agent: RunAgent): Promise<boolean> {
  if (agent.kind === 'orchestrator') return true;
  if (!isEmployee(agent.kind)) return false;
  if (access.scope === 'all_agents') return true;
  const granted = access.employees.filter(grant => grant.employeeId === agent.id).map(grant => grant.taskId);
  if (!granted.length) return false;
  /* Inbox turns keep their tasks on the letters the turn took. */
  const inbox = agent.jobId
    ? exists(tx.select(idOnly(agentInbox)).from(agentInbox).where(and(
      eq(agentInbox.jobId, agent.jobId), eq(agentInbox.agentId, agent.id), eq(agentInbox.companyId, companyId),
      eq(agentInbox.taskId, tasks.id), inArray(agentInbox.status, ['read', 'done']),
    )))
    : undefined;
  const source = or(agent.taskId ? eq(tasks.id, agent.taskId) : undefined, inbox);
  if (!source) return false;
  const [task] = await tx.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, granted), notInArray(tasks.status, [...CLOSED]), source)).limit(1);
  return task !== undefined;
}

/* A command runs this many seconds unless the orchestrator gives its own time, never longer than the most. */
export const RUN_DEFAULT_S = 300;
export const RUN_MAX_S = 1800;
/* How long one tool call waits for a command's answer: under the minute Codex gives a tool. */
export const WAIT_MS = 45_000;
/* A machine is reachable when its keeper asked, with its updater alive, within this. */
export const SEEN_MS = 60_000;
/* Commands that ended, and ones that were lost, go after this long. */
const RUN_KEEP_MS = 24 * 3_600_000;
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
const OUTPUT_MAX = 30_000;
const POLL_MS = 250;
/* What a command that never ran answers, as the updater does for one on a closed computer. */
const CLOSED_EXIT = 126;

/* A machine of the company that has the company's core, and so can have its computer opened. */
/* name: what it is called in the log and to the orchestrator. hostname: the name its computer told, or none, for a
   screen that names an unnamed machine in the reader's own language. */
export type AccessMachine = { id: string; networkId: string; name: string; hostname: string; personId: string; role: MachineRole | null; os: 'linux' | 'darwin' | null; data: boolean };
export type AccessState = { machine: AccessMachine; reachable: boolean } & (
  { open: false; scope: null; employees: [] } | ({ open: true } & Access)
);
export type AccessView = AccessState & { canOpen: boolean; canClose: boolean };
export type RunResult = { exit: number; output: string };
/* A command's answer, or that it still runs, that there is no such command, or that its machine's core lost it. */
export type Waited = RunResult | 'running' | 'gone' | 'lost';
/* forget: the commands the keeper named that are no longer out with it, whose files it lets go of. */
export type Taken = { access: { standing: true } | null; runs: { id: string; command: string; timeout: number }[]; forget: string[] };

type Row = typeof machines.$inferSelect;

export const canViewComputer = (me: { scopeKind: string; viaHead?: true }): boolean => me.scopeKind === 'company' && !me.viaHead;

const ownsComputer = (me: Pick<Person, 'id' | 'status' | 'via' | 'viaHead'>, machine: { personId: string }): boolean =>
  !me.via && !me.viaHead && me.status === 'active' && me.id === machine.personId;

/* What a line in the log says of the machine, when it is known. */
export const onMachine = (machine: string | null): Record<string, string> => (machine ? { machine } : {});
/* The name a line of the log keeps for a machine: the one its computer told. The server's own machine that told none is
   left unnamed there, and each screen names it in the reader's own language. */
export const logName = (machine: Pick<AccessMachine, 'hostname' | 'name' | 'data'>): string | null => machine.hostname || (machine.data ? null : machine.name);

export const closedLine = (name: string): string => `The owner closed access to ${name}.`;
const staleLine = (name: string): string => `${name} did not take this command in time, so it was not run.`;
const noCore = () => new ApiError(404, 'not_found', "This machine has none of the company's core, so there is no computer access on it.", 'no_core');

const LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/* The machine's row is held by the caller. A sent command is forgotten by its keeper on the next poll. */
async function endRuns(tx: Db, machineId: string, output: string, now: Date, filter?: SQL): Promise<void> {
  const run = and(eq(computerRuns.machineId, machineId), filter);
  await tx.update(computerRuns).set({ state: 'done', exit: CLOSED_EXIT, output, doneAt: now }).where(and(run, eq(computerRuns.state, 'waiting')));
  await tx.update(computerRuns).set({ state: 'lost', doneAt: now }).where(and(run, eq(computerRuns.state, 'sent')));
}

/* Disconnect's part for computer access, in its transaction, with the machines' rows held: their access goes with
   them, and their commands end. */
export async function dropAccess(tx: Db, machineIds: string[], now: Date): Promise<void> {
  if (machineIds.length === 0) return;
  const rows = await tx.select({ id: machines.id, hostname: machines.hostname }).from(machines).where(inArray(machines.id, machineIds));
  await tx.delete(machineAccess).where(inArray(machineAccess.machineId, machineIds));
  for (const row of rows) await endRuns(tx, row.id, `Access to ${row.hostname || 'this machine'} ended when it was disconnected.`, now);
}

/* Computer access to each machine of the company that has its core. The state is rows only this app writes while it
   leads; each machine's own keeper asks for it, hands the commands to its updater and brings the answers back. */
export class Computers {
  readonly waitMs: number;
  private readonly now: () => Date;
  private readonly pause: (ms: number) => Promise<unknown>;
  private readonly seenAt = new Map<string, number>();
  private clearedAt = 0;

  constructor(
    private readonly ctx: Pick<Ctx, 'db' | 'config' | 'log'>,
    opts: { now?: () => Date; waitMs?: number; pause?: (ms: number) => Promise<unknown> } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.waitMs = opts.waitMs ?? WAIT_MS;
    /* How a wait for a command's answer lets time go by before it looks again. */
    this.pause = opts.pause ?? sleep;
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

  /* Every connected machine and the access it offers. */
  async states(companyId: string): Promise<AccessState[]> {
    const rows = await this.rows(companyId);
    if (rows.length === 0) return [];
    const grants = await this.ctx.db.select().from(machineAccess).where(inArray(machineAccess.machineId, rows.map(row => row.id)));
    const taskIds = [...new Set(grants.flatMap(row => row.employees.map(grant => grant.taskId)))];
    const openTasks = new Set(taskIds.length ? (await this.ctx.db.select(idOnly(tasks)).from(tasks)
      .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds), notInArray(tasks.status, [...CLOSED])))).map(row => row.id) : []);
    const access = new Map(grants.map(row => [row.machineId, { scope: row.scope, employees: row.employees.filter(grant => openTasks.has(grant.taskId)) }]));
    return rows.map(row => {
      const machine = this.machineOf(row);
      const reachable = this.reachable(row.id);
      return row.computerClosed ? { machine, reachable, open: false, scope: null, employees: [] }
        : { machine, reachable, open: true, ...(access.get(row.id) ?? orchestratorOnly()) };
    });
  }

  async views(me: Person): Promise<AccessView[]> {
    return (await this.states(me.companyId)).map(state => {
      const own = ownsComputer(me, state.machine);
      return { ...state, canOpen: own, canClose: own };
    });
  }

  async view(me: Person, machineId: string): Promise<AccessView | null> {
    return (await this.views(me)).find(view => view.machine.id === machineId) ?? null;
  }

  /* The machine's row, held for the rest of the transaction, when it is a live machine of the company with a core. */
  private async held(tx: Db, companyId: string, machineId: string, strength: 'update' | 'share' = 'update'): Promise<Row | null> {
    const [row] = await tx.select().from(machines).where(and(eq(machines.id, machineId), eq(machines.companyId, companyId))).for(strength);
    return row && !row.revokedAt && row.networkId ? row : null;
  }

  /* The owner can take access away even while the machine is offline. Reopening restores standing access alone. */
  async setOpen(me: Person, machineId: string, open: boolean): Promise<{ machine: AccessMachine; changed: boolean }> {
    return this.ctx.db.transaction(async tx => {
      const [person] = await tx.select({ id: people.id, status: people.status }).from(people).where(and(eq(people.id, me.id), eq(people.companyId, me.companyId))).for('share');
      const row = await this.held(tx, me.companyId, machineId);
      if (!row) throw noCore();
      const machine = this.machineOf(row);
      if (!person || !ownsComputer({ ...me, ...person }, machine)) {
        throw new ApiError(403, 'forbidden', `Only the owner of ${machine.name} can close or reopen its computer access.`, 'not_machine_owner');
      }
      const changed = open === row.computerClosed;
      if (changed) {
        await tx.update(machines).set({ computerClosed: !open }).where(eq(machines.id, machineId));
        if (!open) {
          await tx.delete(machineAccess).where(eq(machineAccess.machineId, machineId));
          await endRuns(tx, machineId, closedLine(machine.name), this.now());
        }
      }
      return { machine, changed };
    });
  }

  private async accessOf(tx: Db, machineId: string): Promise<Access> {
    const [access] = await tx.select({ scope: machineAccess.scope, employees: machineAccess.employees }).from(machineAccess).where(eq(machineAccess.machineId, machineId));
    return access ?? orchestratorOnly();
  }

  async delegate(job: RunJob, machineId: string, to: Delegation, revoke: boolean): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, job.companyId, machineId);
      if (!row) throw noCore();
      if (row.computerClosed) throw new ApiError(409, 'conflict', closedLine(this.nameOf(row)));
      const agent = await this.runAgent(tx, job);
      if (agent?.kind !== 'orchestrator') throw new ApiError(403, 'forbidden', 'Only the orchestrator changes employee computer access.');
      const access = await this.accessOf(tx, machineId);
      if ('allAgents' in to) {
        access.scope = revoke ? 'orchestrator' : 'all_agents';
      } else {
        const [employee] = await tx.select(only(agents, 'kind')).from(agents)
          .where(and(eq(agents.id, to.employee), eq(agents.companyId, job.companyId), isNull(agents.removedAt))).for('share');
        const task = await taskByRef({ db: tx }, job.companyId, to.task);
        if (!task || (!revoke && (!employee || !isEmployee(employee.kind) || CLOSED.includes(task.status)))) {
          throw new ApiError(404, 'not_found', 'Name a company employee and an open company task.');
        }
        access.employees = access.employees.filter(grant => grant.employeeId !== to.employee || grant.taskId !== task.id);
        if (!revoke) access.employees.push({ employeeId: to.employee, taskId: task.id });
      }
      await tx.insert(machineAccess).values({ machineId, companyId: job.companyId, ...access }).onConflictDoUpdate({ target: machineAccess.machineId, set: access });
      if (revoke) await this.endUnpermitted(tx, row, access, this.now());
    });
  }

  /* Read the actual job and agent in the transaction; caller fields cannot invent a role or company. */
  private async runAgent(tx: Db, job: RunJob) {
    const [agent] = await tx.select({ id: agents.id, kind: agents.kind, taskId: jobs.taskId, jobId: jobs.id }).from(jobs)
      .innerJoin(agents, eq(agents.id, jobs.agentId))
      .where(and(eq(jobs.id, job.id), eq(jobs.agentId, job.agentId), eq(jobs.companyId, job.companyId), eq(agents.companyId, job.companyId), isNull(agents.removedAt)))
      .for('share', { of: [jobs, agents] });
    return agent;
  }

  /* A queued or running command loses its access when the employee's grant is withdrawn or their task ends. */
  private async endUnpermitted(tx: Db, row: Row, access: Access, now: Date): Promise<void> {
    const active = await tx.select({
      runId: computerRuns.id, id: agents.id, kind: agents.kind, companyId: agents.companyId, removed: agents.removedAt,
      taskId: jobs.taskId, jobId: jobs.id,
    }).from(computerRuns)
      .innerJoin(agents, eq(agents.id, computerRuns.agentId)).leftJoin(jobs, eq(jobs.id, computerRuns.jobId))
      .where(and(eq(computerRuns.machineId, row.id), inArray(computerRuns.state, ['waiting', 'sent'])));
    const ended: string[] = [];
    for (const agent of active) {
      if (agent.removed || agent.companyId !== row.companyId || !(await allows(tx, row.companyId, access, agent))) ended.push(agent.runId);
    }
    if (ended.length) await endRuns(tx, row.id, `Employee access to ${this.nameOf(row)} ended.`, now, inArray(computerRuns.id, ended));
  }

  async start(job: RunJob, machineId: string, command: string, timeoutS: number): Promise<{ id: string } | 'closed' | 'not_granted' | 'unreachable' | 'none'> {
    return this.ctx.db.transaction(async tx => {
      const row = await this.held(tx, job.companyId, machineId, 'share');
      if (!row) return 'none';
      if (row.computerClosed) return 'closed';
      const agent = await this.runAgent(tx, job);
      if (!agent || !(await allows(tx, row.companyId, await this.accessOf(tx, machineId), agent))) return 'not_granted';
      if (!this.reachable(machineId)) return 'unreachable';
      const [run] = await tx.insert(computerRuns).values({ companyId: job.companyId, machineId, jobId: job.id, agentId: job.agentId, command, timeoutS }).returning({ id: computerRuns.id });
      return { id: run!.id };
    });
  }

  /* Waits a while for the command's answer. One that no keeper took in time is ended here too, so whoever asked hears
     that it was not run. */
  async wait(runId: string, companyId: string, agentId: string, ms = this.waitMs): Promise<Waited> {
    const end = this.now().getTime() + ms;
    const mine = and(eq(computerRuns.id, runId), eq(computerRuns.companyId, companyId), eq(computerRuns.agentId, agentId));
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
      else if (this.now().getTime() >= end) return 'running';
      else await this.pause(POLL_MS);
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
  async machineOfRun(runId: string, companyId: string, agentId: string): Promise<{ id: string; name: string } | null> {
    const [found] = await this.ctx.db
      .select({ id: machines.id, hostname: machines.hostname, networkId: machines.networkId })
      .from(computerRuns)
      .innerJoin(machines, eq(machines.id, computerRuns.machineId))
      .where(and(eq(computerRuns.id, runId), eq(computerRuns.companyId, companyId), eq(computerRuns.agentId, agentId)));
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
      if (row.computerClosed) {
        await endRuns(tx, machineId, closedLine(this.nameOf(row)), now);
        return { access: null, runs: [], forget: held };
      }
      await this.endUnpermitted(tx, row, await this.accessOf(tx, machineId), now);
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
      const opened = { standing: true } as const;
      if (stillOut.length > 0) return { access: opened, runs: [], forget };
      const [next] = await tx.select().from(computerRuns).where(and(eq(computerRuns.machineId, machineId), eq(computerRuns.state, 'waiting'))).orderBy(asc(computerRuns.createdAt), asc(computerRuns.id)).limit(1);
      if (!next) return { access: opened, runs: [], forget };
      await tx.update(computerRuns).set({ state: 'sent', sentAt: now }).where(eq(computerRuns.id, next.id));
      return { access: opened, runs: [{ id: next.id, command: next.command, timeout: next.timeoutS }], forget };
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

  /* The machine a person sits at: a request to localhost that did not come over the link came through the front door
     of the machine it names, a worker's when the peer door named one, else the server's own. */
  async here(req: FastifyRequest, companyId: string): Promise<AccessMachine | null> {
    const forwarded = req.headers['x-forwarded-host'];
    if (!LOCALHOST.test(req.headers.host ?? '') || (forwarded !== undefined && !LOCALHOST.test(String(forwarded))) || req.overLink) return null;
    const asker = await askerOf(req, this.ctx.config);
    const all = await this.machines(companyId);
    if (asker && !asker.own) return req.headers[KEEPER_MARK] === '1' ? null : (all.find(machine => machine.id === asker.machine) ?? null);
    return all.find(machine => machine.networkId === this.ctx.config.machineId) ?? null;
  }
}
