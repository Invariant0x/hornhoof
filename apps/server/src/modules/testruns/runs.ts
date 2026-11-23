import { taskFor, logName, type Run } from './run-records.js';
import { WORK_MEMORY_GB, TEST_MINUTES, UNMEASURED_QUIET_MS, OPEN_RUNS, WAIT_MS, AWAY_MS, RERUNS } from './constants.js';
import type { KeptFiles, NodeMessage, RunKind, Workspace } from '@hornhoof/protocol';
import { countOnly, idOnly, only } from '../../db/selections.js';
import { refusePaused } from '../tasks/pause.js';
import { and, asc, eq, exists, inArray, isNotNull, isNull, like, max, notExists, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { nodeHeld } from '../updates/drain.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import { agents, attachments, companies, departments, machines, nodes, people, subscriptions, tasks, testParts, testRuns, type ExternalWait, type LostRun } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { quote } from '../conversation/prompt.js';
import { repoAt } from '../departments/repository.js';
import { builtinOf, nodeIdentity, ownBuiltin, ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { builtinMachine, liveNode, shownMachine } from '../nodes/nodes.js';
import { onTask } from '../tasks/file-policy.js';
import { CLOSED, refuse, type Task, type Tx, type Wake } from '../tasks/state.js';
import { note, published } from '../tasks/events.js';
import { endWaitForRun } from '../tasks/external-wait.js';
import { endRunWaits, moveRunStage, recordRunWait } from '../tasks/wait-state.js';
import { keepWakes } from '../tasks/outbox.js';
import { wakeAll } from '../tasks/wake.js';
import type { RunJob, ToolJob } from '../tools/job.js';
import { computerKey, computerState, NO_PARTS, Reservations, type ComputerPlace, type RunRoom } from './capacity.js';
import { bookedBudget, bookedParts, needOf, partBudget, type PartNeed } from './part-budget.js';
import { markPromise, markRun, TESTS_CONTEXT, type RunMark } from './github-status.js';
import { forRun, productPlaces, together } from './load.js';
import { cancelDescription, newEnvironmentRequest, pumpDescriptions, productReceipt, repositoryScope, testCapabilities, testRunMode, type TestRunMode } from './describe.js';
import { checkNamedFiles } from './named-files.js';
import { pickMachine } from './pick.js';
import { runPurpose, runScope, scopeSource, scopeWords } from './purpose.js';
import { closeFileCache, keptFor, recordPartFiles, rememberKept, reuseLines, reuseView } from './reuse.js';
import { keepPartTimings } from './timings.js';
import { alertSilentPart } from './part-silence.js';
import { heldMachines, holdsBuiltin, holdsMachine } from '../network/follow.js';
import { builtinName } from '../nodes/builtin.js';
import { endPartChecks, partsOfNode as ofNode, reconcilePartChecks } from '../nodes/check-slots.js';
type Part = typeof testParts.$inferSelect;
type Department = typeof departments.$inferSelect;
type Repo = NonNullable<Workspace['repo']>;
type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;
/* A machine that said nothing of a part this long past its time limit has lost it. */
const LATE_MS = 2 * 60_000;
/* What a part keeps of its log's end for the result: its last lines. */
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
/* Failed parts whose ends the result shows; the others' are in their logs. */
const SHOWN_FAILURES = 3;

const isId = (s: string) => z.uuid().safeParse(s).success;

/* The node a part went to. */
/* The node a part runs on: a plan's, or the built-in node of the machine named, this app's own where none is. */
const nodeOf = (ctx: Ctx, p: Pick<Part, 'builtin' | 'builtinMachine' | 'nodeId'>): NodeIdentity | null => (p.builtin ? (p.builtinMachine ? builtinOf(p.builtinMachine) : ownBuiltin(ctx.config)) : p.nodeId ? nodeIdentity(p.nodeId) : null);

/* What a run is called where agents read of it, and its state there: a run of work that passed is done. */
const named = (run: Pick<Run, 'kind' | 'number'>) => `${run.kind === 'work' ? 'Work run' : 'Test run'} ${run.number}`;
const stateOf = (run: Pick<Run, 'kind'>, status: string) => (run.kind === 'work' && status === 'passed' ? 'done' : status);
const toolsOf = (kind: RunKind) => (kind === 'work' ? { state: 'work_run', stop: 'stop_work' } : { state: 'test_run', stop: 'stop_tests' });

/* Where an agent reads a run again, part by part. */
const readAgain = (run: Pick<Run, 'kind' | 'number'>) => `${toolsOf(run.kind).state} ${run.number} shows it part by part.`;
/* What a part puts on the task from $HH_OUT: work-<run>-<part>-<name> for work, test-<run>-<part>-<name> for a test run, whose
   logs are tests-<run>-<part>.log. */
const madeWord = (run: Pick<Run, 'kind'>) => (run.kind === 'work' ? 'work' : 'test');
export const madeName = (run: Pick<Run, 'kind' | 'number'>, part: number, name: string) => `${madeWord(run)}-${run.number}-${part}-${name}`;
/* A run's files on its task: its logs and what its parts made. */
const filesOf = (run: Pick<Run, 'kind' | 'number'>) => or(like(attachments.name, `${run.kind}-${run.number}-%`), like(attachments.name, `${madeWord(run)}-${run.number}-%`))!;
/* What a part made, as its run's state names it: always for work, for a test run once it made anything. */
function madeView(run: Pick<Run, 'kind' | 'number'>, part: number, has: Set<string | null>): { made?: string[] } {
  const made = [...has].filter((n): n is string => n !== null && n.startsWith(madeName(run, part, ''))).sort();
  return run.kind === 'work' || made.length ? { made } : {};
}
export const commandFor = (run: Pick<Run, 'command' | 'parts'>, part: number) => run.command.replaceAll('{parts}', String(run.parts)).replaceAll('{part}', String(part));

/* The last lines of a log. */
export function tailOf(log: string): string {
  const lines = log.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};
const upperLimitMinutes = (ms: number): number | null => ms > 0 ? ms / 60_000 : null;

/* Why a part ended other than by its command passing or failing. */
function endedBy(run: Pick<Run, 'timeoutMs' | 'kind' | 'repeatable' | 'commitSha'>, p: Part): string {
  const kept = mayStillRun(p.error ?? '') && !mayRepeat(run, p.error ?? '') ? ', and it did not run again elsewhere, as it may still run there and run_work did not say it is repeatable' : '';
  return lostHow(run, p) + kept;
}

/* A part of a pinned run that checked another commit, or passed without saying which. */
const COMMIT_MISMATCH = 'commit_mismatch';

/* Why a part ended, after its number in the result. */
const ENDED_HOW: Record<string, (run: Pick<Run, 'timeoutMs' | 'commitSha'>, p: Part) => string> = {
  timeout: run => run.timeoutMs ? `it did not end within ${took(run.timeoutMs)}` : 'an operation took too long',
  silent: () => 'it was stopped after too long without output or results',
  upper_limit: run => `it reached the upper time limit of ${took(run.timeoutMs)}`,
  clone_failed: run => (run.commitSha ? 'the pinned commit could not be fetched' : 'the branch could not be cloned'),
  files_failed: () => "the task's files could not be fetched onto its machine",
  cancelled: () => 'it was stopped on its machine',
  machine_restarted: () => 'its machine restarted and lost it',
  machine_offline: () => 'its machine went offline',
  machine_disconnected: () => 'its machine was disconnected from the company',
  subscription_removed: () => 'its machine lost the plan its node ran for',
  no_machine: () => `no machine was free for it within ${took(WAIT_MS)}`,
  no_repository: () => 'the repository is no longer set',
  [COMMIT_MISMATCH]: (run, p) =>
    p.commit
      ? `it checked ${p.commit}, not the pinned commit ${run.commitSha}, so the run proves nothing about that commit`
      : `it did not say which commit it checked, so the run proves nothing about the pinned commit ${run.commitSha}`,
};

function lostHow(run: Pick<Run, 'timeoutMs' | 'commitSha'>, p: Part): string {
  const how = ENDED_HOW[p.error ?? ''];
  if (how) return how(run, p);
  return p.exitCode !== null ? `exit code ${p.exitCode}` : 'it failed';
}

/* How a machine lost a part, after its name. */
const LOST_HOW: Record<string, string> = {
  machine_restarted: 'restarted and lost it',
  machine_offline: 'went offline',
  machine_disconnected: 'was disconnected from the company',
  subscription_removed: 'lost the plan its node ran for',
};
/* A part lost in any way but a restart its node reported may still run on its machine. */
const mayStillRun = (why: string) => why in LOST_HOW && why !== 'machine_restarted';
/* A part of a test run runs again wherever it was lost; a part of work, which may publish, deploy or send something, only
   when it cannot still run, or when its agent said it may run twice. */
const mayRepeat = (run: Pick<Run, 'kind' | 'repeatable'>, why: string) => run.kind === 'tests' || run.repeatable || !mayStillRun(why);
export const lostLine = (l: LostRun) => `${l.machine} ${LOST_HOW[l.why] ?? 'lost it'}`;

/* What a part that ran again went through before. */
const ranAgain = (lost: LostRun[]) => (lost.length ? ` It ran again after ${lost.map(lostLine).join(', and again after ')}.` : '');

/* The commit a run pinned, where agents read of it. */
const pinLine = (run: Pick<Run, 'branch' | 'commitSha'>) => (run.commitSha ? ` Pinned commit: ${run.commitSha} (${run.branch}).` : '');
/* Only a test run can leave a mark on its commit. */
const markLine = (kind: RunKind, found: { department: { repoFullTestCommand: string | null } } | null, command: string) => (kind === 'tests' ? markPromise(found?.department.repoFullTestCommand, command) : '');

/* What a run of the product's environment left out of the whole product, beside what it reused, which reuseLines says, and that it
   leaves no mark on its commit when it does not stand for the whole product. */
function scopeLines(run: Run): string[] {
  const snapshot = run.environmentSnapshot, suite = run.environmentRequest?.suite;
  if (run.kind !== 'tests' || run.command !== '' || !snapshot) return [];
  const scope = runScope(scopeSource(snapshot), suite, 0);
  const left = scope.leftOut.length ? [`It ran profile ${scope.profile}${scopeWords(scope)}`] : [];
  return runPurpose(snapshot, suite) === 'final' ? left : [...left, `It leaves no ${TESTS_CONTEXT} on its commit: only a run of the whole product, with no one suite, does.`];
}

/* A refused run tells why first, in Hornhoof's own words of the refusal, and what to do instead: it is a hint, no result. */
function refusedAccount(run: Run, parts: Part[]): string {
  const why = parts.find(p => p.status === 'refused' && p.tail)?.tail.trim();
  const said = why ? ['', quote(why)] : [];
  return [`${named(run)} was refused before it started, so nothing ran: this is no result and no failure.${pinLine(run)}`, ...said, '', readAgain(run)].join('\n');
}

/* Hornhoof's account of a run that ended: each part, where it ran and how long, the end of what failed, and the files
   on the task. */
function account(run: Run, task: Pick<Task, 'number'>, parts: Part[], files: Set<string>): string {
  if (run.status === 'refused') return refusedAccount(run, parts);
  const lines = [`${named(run)} ${run.kind === 'work' && run.status === 'passed' ? 'is done' : run.status} after ${took((run.finishedAt ?? new Date()).getTime() - run.createdAt.getTime())}.${pinLine(run)}`, ...scopeLines(run), ...reuseLines(run.fileCache, parts)];
  for (const p of parts) {
    const where = p.machineName ? ` on ${p.machineName}` : '';
    const time = p.startedAt && p.finishedAt ? ` in ${took(p.finishedAt.getTime() - p.startedAt.getTime())}` : '';
    const at = p.commit ? `, at ${p.commit.slice(0, 12)}` : '';
    const why = p.status === 'passed' ? '' : `: ${endedBy(run, p)}`;
    lines.push(`Part ${p.part} of ${run.parts} ${p.status === 'passed' ? stateOf(run, 'passed') : 'failed'}${where}${time}${at}${why}.${ranAgain(p.lost)}`);
  }
  const failed = parts.filter(p => p.status !== 'passed' && p.tail);
  for (const p of failed.slice(0, SHOWN_FAILURES)) lines.push('', `The end of part ${p.part}:`, '', quote(p.tail));
  const logs = parts.map(p => logName(run, p.part)).filter(n => files.has(n));
  const made = [...files].filter(n => !logs.includes(n)).sort();
  if (made.length) lines.push('', `What it made is on #${task.number}: ${made.join(', ')}. Get a file with hh-fetch ${task.number} <name>.`);
  if (logs.length) lines.push('', `Each part's full log is on #${task.number}: hh-fetch ${task.number} ${logs[0]}${logs.length > 1 ? `, and so on up to ${logs.at(-1)}` : ''}.`);
  lines.push('', readAgain(run));
  return lines.join('\n');
}

/* A place a part can run: a computer of the company through one of its nodes, or the built-in node. access: what the
   machine's owner reaches; the built-in node reaches every repository. works: its node runs parts of any work, not only
   of test runs. */
/* builtinMachine: the machine of a built-in node's place. */
export type Place = RunRoom & { key: string; node: NodeIdentity; name: string; machineId: string | null; nodeId: string | null; builtin: boolean; builtinMachine: string | null; lent: boolean; access: Access | null; works: boolean };
export type BrowserHeldPlace = { name: string; lent: boolean; access: Access | null; works: boolean; browserError: string };

/* The key of a built-in node's place: the server's own by its bare word, as it always went, another machine's by its id. */
const builtinPlaceKey = (ctx: Ctx, machine: string | null): string => (!machine || machine === ownMachine(ctx.config) ? 'builtin' : `builtin:${machine}`);

const partPlace = (ctx: Ctx, part: Pick<Part, 'builtin' | 'builtinMachine' | 'machineId' | 'nodeId' | 'computer'>): ComputerPlace => {
  const id = nodeOf(ctx, part);
  return { key: part.builtin ? builtinPlaceKey(ctx, part.builtinMachine) : (part.machineId ?? ''), load: id ? ctx.hub.loadOf(id) : null, computer: part.computer };
};

async function companyComputers({ db, config }: Ctx, companyId: string) {
  const rows = await db
    .select({ machine: machines, owner: people })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(and(eq(machines.companyId, companyId), eq(machines.kind, 'computer'), isNull(machines.revokedAt), shownMachine(config)))
    .orderBy(asc(machines.createdAt));
  /* A machine's own node and its plans' nodes; a removed plan's node is on its way out. */
  const live = await db
    .select({ id: nodes.id, machineId: nodes.machineId })
    .from(nodes)
    .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.companyId, companyId), liveNode, isNull(subscriptions.removedAt)))
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
  return { rows, live };
}

/* Only nodes that say how busy they are know test runs, only those with a user of their own for runs take them, and one
   that waits for an update takes none. */
/* The machines whose built-in node is there, the one this server runs on first, then by id. */
const builtinsFirstOwn = (ctx: Ctx): string[] => {
  const own = ownMachine(ctx.config);
  return ctx.hub.builtins().sort((a, b) => Number(b === own) - Number(a === own) || (a < b ? -1 : 1));
};

/* The company's computer a built-in node runs on: the server's own runs on the computer whose key install.sh named as its
   host, another machine's on the row that holds its id in the network. None when it runs on no computer of the company. */
async function builtinComputer(ctx: Ctx, companyId: string, machine: string): Promise<string | null> {
  if (machine === ownMachine(ctx.config)) return (await builtinMachine(ctx.db, ctx.config.hostId, companyId, ctx.config.machineId))?.id ?? null;
  const [row] = await ctx.db.select(idOnly(machines)).from(machines).where(and(eq(machines.networkId, machine), isNull(machines.revokedAt)));
  return row?.id ?? null;
}

/* Whether a built-in node is lent, as a condition its write checks: taken back, the computer it runs on lends none of
   its nodes. One on no computer of the company is lent, as it always was. */
export async function builtinLent(ctx: Ctx, companyId: string, machine: string): Promise<SQL> {
  const computer = await builtinComputer(ctx, companyId, machine);
  return computer ? notExists(ctx.db.select(idOnly(machines)).from(machines).where(and(eq(machines.id, computer), eq(machines.lendsTests, false)))) : sql`true`;
}

/* The computer a built-in node runs on, none for the server's own, and whether it lends itself to runs. */
async function builtinHost(ctx: Ctx, companyId: string, machine: string): Promise<{ machineId: string | null; lent: boolean }> {
  const computer = await builtinComputer(ctx, companyId, machine);
  const [row] = computer ? await ctx.db.select({ lent: machines.lendsTests }).from(machines).where(eq(machines.id, computer)) : [];
  return { machineId: machine === ownMachine(ctx.config) ? null : computer, lent: row?.lent ?? true };
}

const takesParts = (ctx: Ctx, node: NodeIdentity): boolean =>
  !nodeHeld(ctx, node) && ctx.hub.isReady(node) && ctx.hub.loadOf(node) !== null && ctx.hub.noRunsOf(node) === null;

export async function placesOf(ctx: Ctx, companyId: string): Promise<Place[]> {
  const { db, hub } = ctx;
  const running = (await bookedParts(db)).map(part => ({ ...partPlace(ctx, part), ...bookedBudget(part) }));
  const { rows, live } = await companyComputers(ctx, companyId);
  const places: Place[] = [];
  for (const { machine, owner } of rows) {
    const ready = live.filter(n => n.machineId === machine.id && takesParts(ctx, nodeIdentity(n.id))).map(n => n.id);
    if (!ready.length) continue;
    /* A node that runs work takes test runs too. */
    const node = ready.find(id => hub.runsWork(nodeIdentity(id))) ?? ready[0]!;
    places.push({
      key: machine.id,
      node: nodeIdentity(node),
      name: machine.hostname || 'a machine',
      machineId: machine.id,
      nodeId: node,
      builtin: false,
      builtinMachine: null,
      lent: machine.lendsTests,
      busy: false,
      usage: NO_PARTS,
      load: forRun(hub.loadOf(nodeIdentity(node)), together(ready.map(id => hub.loadOf(nodeIdentity(id))))),
      access: await accessOf(db, owner),
      works: hub.runsWork(nodeIdentity(node)),
    });
  }
  /* Each machine's built-in node that is there is a place too, the server's own first. */
  const builtins = builtinsFirstOwn(ctx);
  for (const machine of builtins) {
    const node = builtinOf(machine);
    if (!takesParts(ctx, node)) continue;
    const { machineId, lent } = await builtinHost(ctx, companyId, machine);
    places.push({
      key: builtinPlaceKey(ctx, machine), node, name: await builtinName(ctx, db, machine), machineId, nodeId: null, builtin: true, builtinMachine: machine,
      lent, busy: false, usage: NO_PARTS, load: together([hub.loadOf(node)]), access: null, works: hub.runsWork(node),
    });
  }
  const reports = [...live.map(n => hub.loadOf(nodeIdentity(n.id))), ...builtins.map(machine => hub.loadOf(builtinOf(machine)))];
  return places.map(p => ({ ...p, ...computerState(p, running, reports) }));
}

export async function browserHeldPlaces(ctx: Ctx, companyId: string): Promise<BrowserHeldPlace[]> {
  const { db, hub } = ctx;
  const { rows, live } = await companyComputers(ctx, companyId);
  const held: BrowserHeldPlace[] = [];
  for (const { machine, owner } of rows) {
    const mine = live.filter(n => n.machineId === machine.id).map(n => nodeIdentity(n.id));
    const browserError = mine.map(id => hub.browserHoldOf(id)).find((err): err is string => err !== null);
    if (!browserError) continue;
    held.push({ name: machine.hostname, lent: machine.lendsTests, access: await accessOf(db, owner), works: mine.some(id => hub.runsWork(id)), browserError });
  }
  for (const machine of builtinsFirstOwn(ctx)) {
    const node = builtinOf(machine);
    const builtinError = hub.browserHoldOf(node);
    if (builtinError) held.push({ name: await builtinName(ctx, db, machine), lent: (await builtinHost(ctx, companyId, machine)).lent, access: null, works: hub.runsWork(node), browserError: builtinError });
  }
  return held;
}

export async function browserHoldReason(ctx: Ctx, companyId: string, run: Pick<Run, 'kind'>, department: Department | null): Promise<string | null> {
  const held = (await browserHeldPlaces(ctx, companyId)).filter(p => mayTake(p, run, department));
  if (!held.length) return null;
  return `Playwright browsers failed to start on ${held.map(p => `${p.name} (${p.browserError})`).join('; ')}.`;
}

/* A failed browser's word on why a run has nowhere to go: only when no place may take it. */
export const browserHeldRun = async (ctx: Ctx, companyId: string, places: Place[], run: Pick<Run, 'kind'>, department: Department | null): Promise<string | null> =>
  (places.some(p => mayTake(p, run, department)) ? null : browserHoldReason(ctx, companyId, run, department));

/* The machine's owner reaches the department a run is for; a run for no department only someone who sees the whole
   company. */
export const reaches = (place: Pick<Place, 'access'>, d: Department | null) =>
  place.access === null || (d ? canReach(place.access, { departmentId: d.id, parentId: d.parentId }) : place.access.whole);

/* Whether a place may take a part of this run at all, busy or not. */
export const mayTake = (place: Pick<Place, 'lent' | 'access' | 'works'>, run: Pick<Run, 'kind'>, d: Department | null) =>
  place.lent && reaches(place, d) && (run.kind !== 'work' || place.works);

/* What a run's parts need: the repository they clone, if any, and the department whose people's machines may take
   them. None when the repository is gone. */
export async function targetOf(ctx: Ctx, run: Pick<Run, 'kind' | 'branch' | 'departmentId'>): Promise<{ department: Department | null; repo: Repo | null } | null> {
  if (run.kind === 'tests' || run.branch) return repoAt(ctx, [run.departmentId]);
  const [department] = run.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, run.departmentId)) : [];
  return { department: department ?? null, repo: null };
}

/* Snapshot companies before assigning parts, so reservations in this pass are counted exactly once. */
async function queuePlaces(ctx: Ctx, companyIds: string[]): Promise<Map<string, Place[]>> {
  const places = new Map<string, Place[]>();
  /* A machine that installs its build is no place for a part: offered, it would be picked for being idle, and every
     part would wait for it while others stand free. Nor is the one next to install, so the parts there end and it has
     its turn. The server's own node is never such a machine. */
  const busy = await heldMachines(ctx);
  for (const id of new Set(companyIds)) places.set(id, (await placesOf(ctx, id)).filter(place => !place.machineId || !busy.has(place.machineId)));
  return places;
}

/* A part laid out for a computer by its pace waits for that computer while it is online and may take it; after a loss, or when it
   cannot, any computer does. Prefer another computer after a loss, falling back when only a previously used computer can fit the part. */
function placeFor(open: Place[], part: Part, eligible: (place: Place) => boolean, reserved: Reservations, need: PartNeed, limit: number | undefined): Place | null {
  const spots = open.map(p => ({ key: p.key, computer: computerKey(p), lent: p.lent, reaches: eligible(p), ...reserved.room(p) }));
  const laidOut = part.lost.length ? [] : spots.filter(s => s.computer === part.environmentSelection?.computer && s.lent && s.reaches);
  if (laidOut.length) { const own = pickMachine(laidOut, need, limit); return own ? open.find(p => p.key === own.key) ?? null : null; }
  const lostOn = new Set(part.lost.flatMap(l => [l.key, l.computer ?? computerKey(open.find(p => p.key === l.key) ?? { key: l.key, load: null })]));
  const spot = pickMachine(spots.filter(s => !lostOn.has(s.key) && !lostOn.has(s.computer)), need, limit) ?? pickMachine(spots, need, limit);
  return spot ? open.find(p => p.key === spot.key) ?? null : null;
}

const partMessage = (run: Run, part: Part, repo: Repo | null, task: number, vitestWorkers: number) => ({
  type: 'tests.run' as const,
  ...productMessage(run, part, repo),
  partId: part.id,
  ...(run.kind === 'work' ? { kind: 'work' as const, files: run.files } : {}),
  repo: repo ? { url: repo.url, token: repo.token } : null,
  branch: run.branch,
  commitSha: run.commitSha,
  task,
  command: commandFor(run, part.part),
  part: part.part,
  parts: run.parts,
  ...(run.timeoutMs ? { timeoutMs: run.timeoutMs } : {}),
  vitestWorkers,
  silenceMs: partSilenceMs(run, part.environmentSelection?.estimatedMs),
});

function partSilenceMs(run: Run, estimatedMs: number | undefined): number {
  const fallback = run.kind === 'work' ? run.timeoutMs * 0.75 : UNMEASURED_QUIET_MS;
  const quiet = estimatedMs === undefined ? fallback : estimatedMs * 1.5 + 60_000;
  return Math.max(1, Math.min(2 ** 31 - 1, Math.ceil(quiet)));
}

/* Gives waiting parts out oldest first, keeping a shared count of reservations on each physical computer. */
async function giveOut(ctx: Ctx): Promise<void> {
  const { db } = ctx;
  await pumpDescriptions(ctx, companyId => placesOf(ctx, companyId), run => targetOf(ctx, run), id => settleRun(ctx, id));
  /* A run whose every file was reused has no part whose end would end it. */
  for (const { id } of await db.select(idOnly(testRuns)).from(testRuns).where(and(eq(testRuns.status, 'running'), eq(testRuns.parts, 0), isNotNull(testRuns.environmentSnapshot)))) await settleRun(ctx, id);
  const waiting = await db
    .select({ part: testParts, run: testRuns, task: { number: tasks.number } })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(eq(testParts.status, 'queued'))
    .orderBy(asc(testRuns.createdAt), asc(testParts.part));
  const places = await queuePlaces(ctx, waiting.map(w => w.run.companyId));
  const reserved = new Reservations();
  const targets = new Map<string, Awaited<ReturnType<typeof targetOf>>>();
  for (const entry of waiting) await givePart(ctx, entry, places, reserved, targets);
}

const pumps = new WeakMap<Ctx, Promise<void>>();

/* Waiting parts go out to machines that are free now, one round at a time, so two rounds never give one part twice. */
export function pumpTests(ctx: Ctx): Promise<void> {
  const next = (pumps.get(ctx) ?? Promise.resolve()).then(() => giveOut(ctx)).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'Test runs could not be given out to machines.'));
  pumps.set(ctx, next);
  return next;
}

type RunEnd = { wakes: Wake[]; changed: Task | null };

const goesOnLine = (wait: ExternalWait | null) => wait ? `\n\nYour wait for "${wait.reason}" goes on until ${wait.until}. If this run was what it waited for, end it with end_wait.` : '';

/* What the end of a run means for its task, in the one place every way a run ends goes through and in the write that ends
   it: what waits for this run is over, and the one who started it hears of it once. always: tell it even with no wait to
   end. Nobody hears of a run on a closed task. */
async function tellEnd(tx: Tx, run: Run, task: Task, text: string, always: boolean): Promise<RunEnd> {
  await endRunWaits(tx, { taskId: task.id, runId: run.id, outcome: run.status === 'stopped' ? 'cancelled' : 'resolved', proofRef: `run:${run.id}:${run.status}`, actor: { agentId: run.agentId } });
  if (CLOSED.includes(task.status)) return { wakes: [], changed: null };
  const { waited, goesOn } = await endWaitForRun(tx, task.id, run.agentId, { id: run.id, label: named(run) });
  if (!always && !waited) return { wakes: [], changed: task };
  const wakes: Wake[] = [{ agentId: run.agentId, taskId: run.taskId, why: run.kind, text: text + goesOnLine(goesOn) }];
  await keepWakes(tx, run.companyId, wakes);
  return { wakes, changed: task };
}

/* What the write that ended a run kept, once it is kept. */
async function told(ctx: Ctx, end: RunEnd): Promise<void> {
  if (end.changed) published(ctx, end.changed);
  await wakeAll(ctx, end.wakes);
}

/* What a mark on the run's commit adds: a line in the log of its task, where the one who decides reads it later. It is no
   move of the task, whoever's turn is running. */
async function keepMark(tx: Tx, run: Run, task: Task, mark: RunMark | null): Promise<string> {
  if (!mark) return '';
  await note(tx, task, { kind: 'comment', actor: { agentId: run.agentId }, text: mark.line, data: { testsMark: mark.data } });
  return `\n\n${mark.line}`;
}

async function recordRunEnd(ctx: Ctx, runId: string, parts: Part[], status: 'passed' | 'failed' | 'refused', mark: RunMark | null): Promise<RunEnd | null> {
  return ctx.db.transaction(async tx => {
    /* The task first, then the run: the order every write that holds both takes. */
    const [found] = await tx.select({ task: tasks }).from(testRuns).innerJoin(tasks, eq(tasks.id, testRuns.taskId)).where(eq(testRuns.id, runId)).for('update', { of: tasks });
    if (!found) return null;
    const { task } = found;
    const [ended] = await tx
      .update(testRuns)
      .set({ status, finishedAt: new Date() })
      .where(and(eq(testRuns.id, runId), eq(testRuns.status, 'running')))
      .returning();
    if (!ended) return null;
    const run = await closeFileCache(tx, ended);
    const files = await tx.select(only(attachments, 'name')).from(attachments).where(and(eq(attachments.taskId, run.taskId), filesOf(run)));
    const marked = await keepMark(tx, run, task, mark);
    return tellEnd(tx, run, task, account(run, task, parts, new Set(files.map(l => l.name!))) + marked, true);
  });
}

/* A described run planned with no part at all: nothing was left to run. Before its description a run has no parts either. */
async function everythingReused(ctx: Ctx, runId: string): Promise<boolean> {
  const [run] = await ctx.db.select(idOnly(testRuns)).from(testRuns).where(and(eq(testRuns.id, runId), eq(testRuns.parts, 0), isNotNull(testRuns.environmentSnapshot)));
  return run !== undefined;
}

/* A part that started and failed fails its run. A run none of whose parts failed, but one of which Hornhoof refused before it
   started, is refused: it proves nothing, and it is no failure either. */
export function runEnd(parts: Pick<Part, 'status'>[]): 'passed' | 'failed' | 'refused' {
  if (parts.every(p => p.status === 'passed')) return 'passed';
  return parts.some(p => p.status === 'refused') && !parts.some(p => p.status === 'failed') ? 'refused' : 'failed';
}

/* A run whose parts all ended ends with them, and its agent hears how it went on its task. The mark goes out before the
   write that ends the run, so the one result the agent hears says how it went; a crash in between ends and marks it again. */
async function settleRun(ctx: Ctx, runId: string): Promise<void> {
  const parts = await ctx.db.select().from(testParts).where(eq(testParts.runId, runId)).orderBy(asc(testParts.part));
  if (parts.some(p => p.status === 'queued' || p.status === 'running')) return;
  if (!parts.length && !await everythingReused(ctx, runId)) return;
  const status = runEnd(parts);
  const mark = status === 'refused' ? null : await markRun(ctx, runId, status);
  const end = await recordRunEnd(ctx, runId, parts, status, mark);
  if (end) await told(ctx, end);
}

/* Parts that end without a word from their node, and the runs they finish. */
async function endParts(ctx: Ctx, which: SQL, error: string, tail = ''): Promise<void> {
  const ended = await ctx.db
    .update(testParts)
    .set({ status: 'failed', error, finishedAt: new Date(), ...(tail ? { tail } : {}) })
    .where(and(which, inArray(testParts.status, ['queued', 'running'])))
    .returning();
  cancelParts(ctx, ended);
  for (const p of ended) await stopWithPreparation(ctx, p);
  for (const runId of new Set(ended.map(p => p.runId))) await settleRun(ctx, runId);
}

/* The batches of a run start beside its preparation, but a preparation that failed decides the run: none of them keeps a machine
   for it. What runs stops on its machine, and what waits never starts. */
async function stopWithPreparation(ctx: Ctx, part: Part): Promise<void> {
  if (part.status !== 'failed' || part.environmentSelection?.selection.kind !== 'prepare') return;
  await endParts(ctx, eq(testParts.runId, part.runId), 'prerequisite_failed', 'The preparation failed; this part was stopped.');
}

const lostAt = (ctx: Ctx, part: Part, why: string): LostRun => {
  const place = partPlace(ctx, part);
  return { key: place.key, computer: computerKey(place), machine: part.machineName ?? 'a machine', why };
};

/* Parts their machines lost as they ran, as when a machine restarted, went offline, was disconnected or lost the plan its
   node ran for: each waits for another machine under a new id, so its lost run, should that come back, is told apart.
   One lost RERUNS times already fails with why. */
export async function loseParts(ctx: Ctx, which: SQL, why: string): Promise<void> {
  const lost = await ctx.db
    .select({ part: testParts, run: testRuns })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(which, eq(testParts.status, 'running')));
  for (const { part: p, run } of lost) {
    const running = and(eq(testParts.id, p.id), eq(testParts.status, 'running'))!;
    if (p.lost.length >= RERUNS || !mayRepeat(run, why)) {
      await endParts(ctx, running, why);
      continue;
    }
    const where = lostAt(ctx, p, why);
    const [again] = await ctx.db
      .update(testParts)
      .set({ id: sql`gen_random_uuid()`, status: 'queued', lost: [...p.lost, where], nodeId: null, builtin: false, machineId: null, machineName: null, computer: null, startedAt: null, queuedAt: new Date() })
      .where(running)
      .returning({ id: testParts.id });
    if (again) cancelParts(ctx, [p]);
    /* What the lost attempt put on the task goes: the part makes it again, and the old id takes no more. */
    if (again) {
      await ctx.db.delete(attachments).where(and(eq(attachments.taskId, run.taskId), like(attachments.name, `${madeName(run, p.part, '')}%`)));
    }
    if (again) await runReached(ctx, run, 'retry');
  }
  await pumpTests(ctx);
}

/* A part's log goes on its task as a file of the turn that started the run, once. */
async function keepLog(ctx: Ctx, run: Run, part: Part, log: string): Promise<void> {
  const name = logName(run, part.part);
  const [had] = await ctx.db.select(idOnly(attachments)).from(attachments).where(and(eq(attachments.taskId, run.taskId), eq(attachments.name, name))).limit(1);
  if (had) return;
  const bytes = Buffer.from(log, 'utf8');
  await ctx.db.insert(attachments).values({ companyId: run.companyId, jobId: run.jobId, agentId: run.agentId, taskId: run.taskId, name, mediaType: 'text/plain; charset=utf-8', bytes, size: bytes.length });
}

/* The node began a part: its time counts from now. */
export async function partStarted(ctx: Ctx, id: NodeIdentity, partId: string): Promise<void> {
  if (!isId(partId)) return;
  await ctx.db
    .update(testParts)
    .set({ startedAt: new Date() })
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), ofNode(ctx, id)));
}

/* How a part's end counts for its run. A part of a pinned run that checked another commit, or passed without saying
   which, proves nothing about that commit, whatever its command did. One that failed before it reached any commit keeps
   its own reason. */
type PartEnd = 'passed' | 'failed' | 'refused';
/* A node from before refusals had a word of their own says "failed" for a part its command guard stopped: one that never
   started, has no exit code and says it was stopped before it started. */
const OLD_REFUSAL = 'Hornhoof stopped this command before it started.';
const refusedBefore = (part: Pick<Part, 'startedAt'>, msg: Pick<TestsDone, 'ok' | 'error' | 'exitCode' | 'log'>) =>
  !msg.ok && (msg.error === 'refused' || (msg.error === 'failed' && msg.exitCode === null && part.startedAt === null && msg.log.includes(OLD_REFUSAL)));
function partEnd(run: Pick<Run, 'commitSha'>, part: Pick<Part, 'startedAt'>, msg: Pick<TestsDone, 'ok' | 'commit' | 'error' | 'exitCode' | 'log'>): { status: PartEnd; error: string | null } {
  if (refusedBefore(part, msg)) return { status: 'refused', error: 'refused' };
  const skewed = run.commitSha !== null && (msg.commit ? msg.commit !== run.commitSha : msg.ok);
  if (skewed) return { status: 'failed', error: COMMIT_MISMATCH };
  return msg.ok ? { status: 'passed', error: null } : { status: 'failed', error: msg.error ?? 'failed' };
}

/* What a run keeps for later never decides how this one ends: without it, a later run only runs more. */
async function keepPartResults(ctx: Ctx, run: Run, part: Part, ended: Part, msg: TestsDone): Promise<void> {
  try { await recordPartFiles(ctx, run, part, ended, msg); await rememberKept(ctx, run, msg); }
  catch (err) { ctx.log.error({ error: loggable(err), runId: run.id }, 'The results of a test part could not be kept.'); }
  try { if (run.kind === 'tests') await keepPartTimings(ctx.db, run, ended, msg); }
  catch (err) { ctx.log.error({ error: loggable(err), runId: run.id }, 'The file times of a test part could not be kept.'); }
}

/* The node's end of a part: its result, and its log on the task, also for a part that ended here first. */
export async function partDone(ctx: Ctx, id: NodeIdentity, msg: TestsDone): Promise<void> {
  const { db } = ctx;
  if (isId(msg.partId)) {
    const [found] = await db.select({ part: testParts, run: testRuns }).from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId)).where(and(eq(testParts.id, msg.partId), ofNode(ctx, id)));
    if (found && found.part.status !== 'queued') {
      /* The node may have lost its connection before sending the live alert. Its final result survives reconnect. */
      if (!msg.ok && msg.error === 'silent') await alertSilentPart(ctx, id, msg.partId)
        .catch((err: unknown) => ctx.log.error({ error: loggable(err), partId: msg.partId }, 'The silent part alarm could not be sent.'));
      const [ended] = await db
        .update(testParts)
        .set({ ...productPartEnd(ctx, id, found.run, found.part, msg), commit: msg.commit, exitCode: msg.exitCode, tail: tailOf(msg.log), finishedAt: new Date() })
        .where(and(eq(testParts.id, msg.partId), eq(testParts.status, 'running')))
        .returning();
      endPartChecks(ctx, id, msg.partId, true);
      await keepLog(ctx, found.run, found.part, msg.log);
      if (ended) await keepPartResults(ctx, found.run, found.part, ended, msg);
      if (ended) await stopWithPreparation(ctx, ended);
      /* Also when the part had ended: the end the node sends again ends the run the first one did not reach. */
      await settleRun(ctx, found.run.id);
    } else endPartChecks(ctx, id, msg.partId, true);
  }
  /* The node keeps the end until it hears this, and sends it again after a reconnect; a second one changes nothing. */
  ctx.hub.send(id, { type: 'tests.ack', partId: msg.partId });
  await pumpTests(ctx);
}

/* A node said hello: parts it ran and no longer knows were lost with a restart, and parts it still has that ended here
   meanwhile stop. A node of a build before test runs knows none. */
export async function testsHello(ctx: Ctx, id: NodeIdentity, has: string[] = []): Promise<void> {
  const known = has.filter(isId);
  reconcilePartChecks(ctx, id, new Set(known));
  await loseParts(ctx, and(ofNode(ctx, id), known.length ? notInArray(testParts.id, known) : undefined)!, 'machine_restarted');
  if (known.length) {
    const open = await ctx.db.select(idOnly(testParts)).from(testParts).where(and(inArray(testParts.id, known), eq(testParts.status, 'running'), ofNode(ctx, id)));
    const keep = new Set(open.map(p => p.id));
    for (const partId of known) if (!keep.has(partId)) cancelPart(ctx, id, partId);
  }
  await pumpTests(ctx);
}

/* Runs left open though every part of theirs ended, as when the server stopped between the end of the last part and that of
   its run: each ends now as its parts did. One that cannot end now does not hold back the others. */
async function settleLeftOpen(ctx: Ctx): Promise<void> {
  const ofRun = eq(testParts.runId, testRuns.id);
  const left = await ctx.db
    .select(idOnly(testRuns))
    .from(testRuns)
    .where(and(eq(testRuns.status, 'running'), exists(ctx.db.select(idOnly(testParts)).from(testParts).where(ofRun)), notExists(ctx.db.select(idOnly(testParts)).from(testParts).where(and(ofRun, inArray(testParts.status, ['queued', 'running']))))));
  for (const { id } of left) await settleRun(ctx, id).catch((err: unknown) => ctx.log.error({ error: loggable(err), runId: id }, 'A test run whose parts all ended could not end.'));
}

const upperLimitPassed = (run: Run, part: Part, now: Date): boolean =>
  run.timeoutMs > 0 && part.status === 'running' && part.startedAt !== null &&
  part.startedAt.getTime() + run.timeoutMs + LATE_MS < now.getTime();

/* Parts past their time limit whose node never said they ended, parts whose machine is away too long, parts that waited too
   long for a machine, and runs whose parts all ended. */
export async function checkTestTimes(ctx: Ctx, now = new Date()): Promise<void> {
  const { db } = ctx;
  await settleLeftOpen(ctx);
  const open = await db
    .select({ part: testParts, run: testRuns })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(inArray(testParts.status, ['queued', 'running']));
  for (const { part, run } of open) {
    if (upperLimitPassed(run, part, now)) {
      const why = run.kind === 'tests' ? 'upper_limit' : 'timeout';
      const tail = why === 'upper_limit' ? `The part reached the upper time limit of ${took(run.timeoutMs)}.` : '';
      await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'running'))!, why, tail);
      continue;
    }
    const node = part.status === 'running' ? nodeOf(ctx, part) : null;
    const away = node && ctx.hub.awaySince(node);
    if (away && away + AWAY_MS < now.getTime()) await loseParts(ctx, eq(testParts.id, part.id), 'machine_offline');
    if (part.status === 'queued' && part.queuedAt.getTime() + WAIT_MS < now.getTime()) {
      await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'queued'))!, 'no_machine');
    }
  }
  await pumpTests(ctx);
}

/* files: the task's files a part of work takes in; memory: the free memory, in GB, it needs; repeatable: it may run twice. */
export type RunInput = { task?: number | string; branch?: string; command?: string; suite?: string; parts?: number; minutes?: number; files?: string[]; memory?: number; repeatable?: boolean };

/* The department whose people's machines may take a run without a repository of its own. */
const taskDepartment = async (ctx: Ctx, task: Pick<Task, 'productId' | 'departmentId'>, kind: RunKind) =>
  (await targetOf(ctx, { kind, branch: null, departmentId: task.productId ?? task.departmentId }))?.department ?? null;

/* What a run's parts check. A test run reads the exact commit from its repository here, before any part goes out, so a
   push after this moment changes nothing about what the run proves. A run of work clones its branch as it finds it. */
async function pinCommit(ctx: Ctx, kind: RunKind, branch: string | undefined, found: { repo: Repo } | null): Promise<{ branch: string | null; commitSha: string | null }> {
  if (kind !== 'tests' || !found || !branch) return { branch: branch ?? null, commitSha: null };
  const at = await ctx.readCommit(found.repo, { branch });
  if ('problem' in at) throw refuse(409, 'repo_invalid', at.problem);
  /* A shared run checks a release, and a release is a branch: a tag of the same name is none. */
  if (at.tag) throw refuse(409, 'tests_not_release', `${branch} is a tag of the repository, not a branch: shared test runs go only to the branch main, a turn's branch turn-<number> or a release-<name> branch.`);
  return { branch: at.branch, commitSha: at.commitSha };
}

async function runRepository(ctx: Ctx, task: Task, input: RunInput, kind: RunKind): Promise<Awaited<ReturnType<typeof repoAt>>> {
  const cloned = kind === 'tests' || input.branch !== undefined;
  const found = cloned ? await repoAt(ctx, [task.productId, task.departmentId]) : null;
  if (cloned && !found) {
    throw refuse(
      409,
      'repo_invalid',
      kind === 'tests'
        ? `#${task.number} has no repository to test: its department has none set.`
        : `#${task.number} has no repository to clone ${input.branch} from: its department has none set. Leave out branch to run in an empty folder.`,
    );
  }
  return found;
}

async function workFiles(ctx: Ctx, task: Task, input: RunInput, kind: RunKind): Promise<string[]> {
  const files = kind === 'work' ? [...new Set(input.files ?? [])] : [];
  if (files.length) {
    const had = await ctx.db.select(only(attachments, 'name')).from(attachments).where(and(eq(attachments.taskId, task.id), inArray(attachments.name, files)));
    const missing = files.find(f => !had.some(h => h.name === f));
    if (missing) throw refuse(404, 'attachment_unknown', `#${task.number} has no file ${missing}. Put it on the task with hh-attach --task ${task.number} first.`);
  }
  return files;
}

async function checkRunCapacity(ctx: Ctx, job: RunJob): Promise<void> {
  const [open] = await ctx.db.select(countOnly()).from(testRuns).where(and(eq(testRuns.agentId, job.agentId), eq(testRuns.status, 'running')));
  if (Number(open?.n ?? 0) >= OPEN_RUNS) throw refuse(409, 'task_invalid', `You have ${OPEN_RUNS} runs going on already. Wait for one to end, or stop one with stop_tests or stop_work.`);
}

type RunSetup = { department: Department | null; pin: Awaited<ReturnType<typeof pinCommit>> };
async function prepareRun(ctx: Ctx, job: RunJob, task: Task, input: RunInput, kind: RunKind, mode: TestRunMode, found: Awaited<ReturnType<typeof repoAt>>): Promise<RunSetup> {
  const department = found?.department ?? await taskDepartment(ctx, task, kind);
  const heldReason = await browserHeldRun(ctx, job.companyId, await placesOf(ctx, job.companyId), { kind }, department);
  if (heldReason) throw refuse(409, 'browser_failed', heldReason);
  const pin = await pinCommit(ctx, kind, input.branch, found);
  checkProductPin(mode.mode, pin.commitSha);
  return { department, pin };
}

function runResources(input: RunInput, kind: RunKind, department: Department | null) {
  const memoryGb = kind === 'work' ? input.memory ?? WORK_MEMORY_GB : needOf({ memoryGb: null }, department);
  return { memoryGb, repeatable: kind === 'work' && input.repeatable === true };
}

function runEnvironment(job: RunJob, mode: TestRunMode, found: Awaited<ReturnType<typeof repoAt>>, minutes: number | undefined) {
  return mode.mode === 'product' ? newEnvironmentRequest(repositoryScope(job.companyId, found!.department.id, found!.repo.url), mode, minutes) : null;
}

/* The caller holds the company row while taking its next run number. */
async function nextRunNumber(tx: Tx, companyId: string): Promise<number> {
  const [last] = await tx.select({ n: max(testRuns.number) }).from(testRuns).where(eq(testRuns.companyId, companyId));
  return (last?.n ?? 0) + 1;
}

async function createRun(ctx: Ctx, job: RunJob, task: Task, input: RunInput, kind: RunKind, mode: TestRunMode, found: Awaited<ReturnType<typeof repoAt>>, setup: RunSetup, files: string[], parts: number): Promise<Run> {
  const { department, pin } = setup;
  return ctx.db.transaction(async tx => {
    /* Numbers go up one by one per company, so starting a run waits on the company row. */
    await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, job.companyId)).for('update');
    const number = await nextRunNumber(tx, job.companyId);
    const [row] = await tx
      .insert(testRuns)
      .values({
        companyId: job.companyId,
        number,
        taskId: task.id,
        agentId: job.agentId,
        jobId: job.id,
        departmentId: department?.id ?? null,
        kind,
        ...pin,
        command: input.command ?? '',
        environmentRequest: runEnvironment(job, mode, found, input.minutes),
        files,
        ...runResources(input, kind, department),
        parts,
        timeoutMs: (input.minutes ?? (kind === 'work' ? TEST_MINUTES : 0)) * 60_000,
      })
      .returning();
    if (parts) await tx.insert(testParts).values(Array.from({ length: parts }, (_, i) => ({ companyId: job.companyId, runId: row!.id, part: i + 1 })));
    await recordRunWait(tx, row!, mode.mode === 'product' ? 'prepare' : 'queue', new Date());
    return row!;
  });
}

/* A shared run of every test goes only on a release: main or the main line its repository names, a turn's branch or a release
   branch. A change is checked by its author's local tests of what it touched. */
function requireRelease(branch: string, mainLine: string): void {
  if (/^(main|turn-\d+|release-.+)$/.test(branch) || branch === mainLine) return;
  throw refuse(409, 'tests_not_release', `${branch} is no release branch: shared test runs go only to main, a turn's branch turn-<number> or a release-<name> branch, so check your change with local tests of what it touched.`);
}

/* Starts a run for a task: a test run of its branch, or any other work, on a branch or in an empty folder with the task's
   files. Its parts go out to free machines now or wait for them. Says how it went out. */
export async function startRun(ctx: Ctx, job: RunJob, input: RunInput, kind: RunKind = 'tests'): Promise<string> {
  const mode = testRunMode(input, kind);
  const task = await taskFor(ctx, job, input.task, kind);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status} already.`);
  refusePaused(task);
  const found = await runRepository(ctx, task, input, kind);
  if (kind === 'tests') requireRelease(input.branch ?? `task-${task.number}`, found!.repo.branch);
  const files = await workFiles(ctx, task, input, kind);
  const parts = mode.mode === 'manual' ? mode.parts : 0;
  checkManualParts(input.command ?? '', parts);
  await checkRunCapacity(ctx, job);
  const setup = await prepareRun(ctx, job, task, input, kind, mode, found);
  const unchecked = await checkNamedFiles(ctx, found, mode, setup.pin);
  const run = await createRun(ctx, job, task, input, kind, mode, found, setup, files, parts);
  published(ctx, task);
  await pumpTests(ctx);
  if (mode.mode === 'product') return `${named(run)} of #${task.number} waits for its pinned product environment description.${pinLine(run)} test_run ${run.number} shows the environment and parts; you are woken with its result.`;
  return (await startedRunSummary(ctx, run, task, found, setup.department)) + unchecked;
}

/* A run the agent may see and stop: its own, or one on a task it works on. */
async function runOf(ctx: Ctx, job: ToolJob, number: number, kind: RunKind): Promise<{ run: Run; task: Task }> {
  const [found] = await ctx.db
    .select({ run: testRuns, task: tasks })
    .from(testRuns)
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testRuns.companyId, job.companyId), eq(testRuns.number, number)));
  if (!found || (found.run.agentId !== job.agentId && !onTask(job, found.task))) throw refuse(404, 'task_unknown', `There is no ${kind === 'work' ? 'work' : 'test'} run ${number} you can see.`);
  return found;
}

/* How a run goes, part by part. */
export async function runState(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<object> {
  const { run, task } = await runOf(ctx, job, number, kind);
  const parts = await ctx.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  const files = await ctx.db.select(only(attachments, 'name')).from(attachments).where(and(eq(attachments.taskId, run.taskId), filesOf(run)));
  const [stopper] = run.stoppedByAgentId ? await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, run.stoppedByAgentId)) : [];
  const has = new Set(files.map(l => l.name));
  const work = run.kind === 'work';
  return {
    run: run.number,
    task: task.number,
    kind: run.kind,
    branch: work ? run.branch : (run.branch ?? `the task's own: task-${task.number} or the one that starts with task-${task.number}-`),
    command: run.command,
    ...productRunView(run),
    ...reuseView(run.fileCache, parts),
    ...(work ? { files: run.files, memoryGb: run.memoryGb, repeatable: run.repeatable } : { commitSha: run.commitSha }),
    minutes: upperLimitMinutes(run.timeoutMs),
    status: stateOf(run, run.status),
    ...(stopper ? { stoppedBy: stopper.name } : {}),
    startedAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    parts: parts.map(p => ({
      part: p.part,
      ...productPartView(p),
      status: stateOf(run, p.status),
      machine: p.machineName,
      commit: p.commit,
      exitCode: p.exitCode,
      ...(p.error && p.status !== 'passed' ? { why: endedBy(run, p) } : {}),
      startedAt: p.startedAt?.toISOString() ?? null,
      finishedAt: p.finishedAt?.toISOString() ?? null,
      log: has.has(logName(run, p.part)) ? logName(run, p.part) : null,
      ...madeView(run, p.part, has),
      ...(p.lost.length ? { ranAgain: p.lost.map(lostLine) } : {}),
      ...(p.status === 'failed' && p.tail ? { end: p.tail } : {}),
    })),
  };
}

function requireRunning(run: Run): void {
  if (run.status !== 'running') throw refuse(409, 'task_invalid', `${named(run)} ${run.status === 'stopped' ? 'is stopped' : stateOf(run, run.status) === 'done' ? 'is done' : run.status} already.`);
}

async function stopperName(ctx: Ctx, job: ToolJob, other: boolean): Promise<string> {
  const [me] = other ? await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId)) : [];
  return other ? (me?.name ?? 'another agent') : 'you';
}

async function recordRunStop(ctx: Ctx, job: ToolJob, run: Run, task: Task, other: boolean, stopper: string) {
  const now = new Date();
  return ctx.db.transaction(async tx => {
    await tx.select(idOnly(tasks)).from(tasks).where(eq(tasks.id, run.taskId)).for('update');
    const [row] = await tx
      .update(testRuns)
      .set({ status: 'stopped', finishedAt: now, stoppedByAgentId: other ? job.agentId : null })
      .where(and(eq(testRuns.id, run.id), eq(testRuns.status, 'running')))
      .returning();
    if (!row) return null;
    const parts = await tx
      .update(testParts)
      .set({ status: 'stopped', finishedAt: now })
      .where(and(eq(testParts.runId, run.id), inArray(testParts.status, ['queued', 'running'])))
      .returning();
    await closeFileCache(tx, row);
    return { parts, end: await tellEnd(tx, row, task, `${named(run)} was stopped by ${stopper}. ${readAgain(run)}`, other) };
  });
}

function cancelParts(ctx: Ctx, parts: Part[]): void {
  for (const p of parts) {
    const node = nodeOf(ctx, p);
    if (node) cancelPart(ctx, node, p.id);
  }
}

function cancelPart(ctx: Ctx, node: NodeIdentity, partId: string): void {
  endPartChecks(ctx, node, partId, false);
  ctx.hub.send(node, { type: 'tests.cancel', partId });
}

/* Stops a run: its waiting parts end here, its running ones on their nodes too. Its agent hears of it when another one
   stopped it, or when it waits on the run. */
export async function stopRun(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<string> {
  const { run, task } = await runOf(ctx, job, number, kind);
  requireRunning(run);
  const other = run.agentId !== job.agentId;
  const stopper = await stopperName(ctx, job, other);
  const stopped = await recordRunStop(ctx, job, run, task, other, stopper);
  if (!stopped) throw refuse(409, 'task_invalid', `${named(run)} ended meanwhile.`);
  cancelParts(ctx, stopped.parts);
  cancelDescription(ctx, run.environmentRequest);
  await told(ctx, stopped.end);
  await pumpTests(ctx);
  return `${named(run)} is stopped.`;
}

/* A running part on this node, and its run, for the part's files. */
export async function runningPartOn(ctx: Ctx, id: NodeIdentity, partId: string): Promise<{ part: Part; run: Run; task: Task } | null> {
  if (!isId(partId)) return null;
  const [found] = await ctx.db
    .select({ part: testParts, run: testRuns, task: tasks })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), ofNode(ctx, id)));
  return found ?? null;
}

function checkManualParts(command: string, parts: number): void {
  if (parts > 1 && !command.includes('{part}')) throw refuse(400, 'task_invalid', 'A command split into parts says which part it runs with {part}, and with {parts} how many there are, as in --shard={part}/{parts}.');
}
function productMessage(run: Run, part: Part, repo: Repo | null): object {
  const repository = repo && run.departmentId ? { repositoryScope: repositoryScope(run.companyId, run.departmentId, repo.url) } : {};
  if (!run.environmentSnapshot || !part.environmentSelection) return repository;
  return { ...repository, environment: { snapshot: run.environmentSnapshot, selection: part.environmentSelection.selection } };
}
async function productPartReady(ctx: Ctx, part: Part): Promise<boolean> {
  const after = part.environmentSelection?.after ?? [];
  if (!after.length) return true;
  const prerequisites = await ctx.db.select().from(testParts).where(and(eq(testParts.runId, part.runId), inArray(testParts.part, after)));
  if (prerequisites.some(p => p.status === 'failed' || p.status === 'stopped' || p.status === 'refused')) {
    await endParts(ctx, eq(testParts.id, part.id), 'prerequisite_failed', 'A required suite part failed; final checks did not run.'); return false;
  }
  return prerequisites.length === after.length && prerequisites.every(p => p.status === 'passed');
}
function productRunView(run: Run): object {
  if (!run.environmentRequest) return {};
  return { mode: 'product', environment: run.environmentSnapshot, environmentHash: run.environmentHash, environmentStatus: run.environmentSnapshot ? 'ready' : run.environmentRequest.problem ? 'failed' : 'describing', environmentProblem: run.environmentRequest.problem };
}
function productPartView(part: Part): object {
  return part.environmentSelection ? { selection: part.environmentSelection.selection, environmentReceipt: part.environmentReceipt } : {};
}

function productPartEnd(ctx: Ctx, id: NodeIdentity, run: Run, part: Part, message: TestsDone): { status: PartEnd; error: string | null; environmentReceipt: Part['environmentReceipt'] } {
  const end = partEnd(run, part, message), environmentReceipt = productReceipt(run.environmentSnapshot, part.environmentSelection, message, testCapabilities(ctx, id).testRuntimes ?? []);
  if (run.environmentSnapshot && message.ok && !environmentReceipt) return { status: 'failed', error: 'environment_invalid', environmentReceipt: null };
  return { ...end, environmentReceipt };
}

function partDispatchLine(part: Part, one: boolean): string {
  const at = part.status === 'running' ? `on ${part.machineName}` : 'waits for a free machine';
  return one ? at : `part ${part.part} ${part.status === 'running' ? 'runs ' : ''}${at}`;
}
async function startedRunSummary(ctx: Ctx, run: Run, task: Task, found: Awaited<ReturnType<typeof repoAt>>, department: Department | null): Promise<string> {
  const went = await ctx.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  const places = (await placesOf(ctx, run.companyId)).filter(p => mayTake(p, run, department));
  const one = went.length === 1;
  const where = went.map(p => partDispatchLine(p, one));
  const none = went.some(p => p.status === 'queued') && !places.length ? ' No machine that may take it is online now, so it waits until one is.' : '';
  return (
    `${named(run)} of #${task.number} ${one && went[0]!.status === 'running' ? 'runs ' : ''}${one ? where[0] : `has ${run.parts} parts: ${where.join(', ')}`}.${none}${pinLine(run)}${markLine(run.kind, found, run.command)} ` +
    `When every part has ended you are woken on #${task.number} with the result; ${toolsOf(run.kind).state} ${run.number} shows how it goes.`
  );
}

const runReached = (ctx: Ctx, run: Run, stage: Parameters<typeof moveRunStage>[2]): Promise<void> => ctx.db.transaction(tx => moveRunStage(tx, run, stage, new Date()));

const withKept = <Message extends object>(message: Message, kept: KeptFiles | undefined) => kept ? { ...message, kept } : message;
async function givePart(ctx: Ctx, { part, run, task }: { part: Part; run: Run; task: { number: number } }, places: Map<string, Place[]>, reserved: Reservations, targets: Map<string, Awaited<ReturnType<typeof targetOf>>>): Promise<void> {
  const { db } = ctx;
    if (!targets.has(run.id)) targets.set(run.id, await targetOf(ctx, run));
    const found = targets.get(run.id)!;
    if (!sameRunTarget(run, found)) {
      await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'queued'))!, 'no_repository', 'The pinned repository configuration changed or is no longer available.');
      return;
    }
    if (!await productPartReady(ctx, part)) return;
    const kept = await keptFor(ctx, run, part);
    const need = partBudget(needOf(run, found.department), run.environmentSnapshot?.description.manifest, part.environmentSelection?.selection);
    const candidates = await productPlaces(ctx, places.get(run.companyId)!, run, need.memoryBytes);
    const place = placeFor(candidates, part, place => mayTake(place, run, found.department), reserved, need, ctx.config.runsPerHost);
    if (!place) {
      /* A machine that could take it has no room for it now; with none at all it stands in the queue as it did. */
      if (candidates.length) await runReached(ctx, run, 'host_slot');
      return;
    }
    /* No part goes to a machine that installs its build now: asked and claimed in one transaction, so the word to install
       and this part never cross. The server's own node is never held so. */
    const taken = await db.transaction(async tx => {
      if (place.builtin ? await holdsBuiltin(tx, ctx.config, place.builtinMachine) : await holdsMachine(tx, place.nodeId)) return null;
      const [claimed] = await tx
        .update(testParts)
        .set({ status: 'running', nodeId: place.nodeId, builtin: place.builtin, builtinMachine: place.builtinMachine, machineId: place.machineId, machineName: place.name, computer: computerKey(place), startedAt: new Date() })
        .where(and(eq(testParts.id, part.id), eq(testParts.status, 'queued')))
        .returning();
      return claimed ?? null;
    });
    if (!taken) return;
    const sent = !nodeHeld(ctx, place.node) && ctx.hub.send(place.node, withKept(partMessage(run, part, found.repo, task.number, need.vitestWorkers), kept));
    /* The node went away or began to wait for an update meanwhile: the part waits for the next machine. */
    if (!sent) {
      await db
        .update(testParts)
        .set({ status: 'queued', nodeId: null, builtin: false, machineId: null, machineName: null, computer: null, startedAt: null })
        .where(and(eq(testParts.id, part.id), eq(testParts.status, 'running')));
    } else {
      reserved.take(place, need);
      await runReached(ctx, run, 'execution');
    }
}

function checkProductPin(mode: 'manual' | 'product', commit: string | null): void {
  if (mode === 'product' && !/^[a-f0-9]{40}$/.test(commit ?? '')) throw refuse(409, 'repo_invalid', 'Product tests need an exact lowercase 40-character commit SHA.');
}

function sameRunTarget(run: Run, target: Awaited<ReturnType<typeof targetOf>>): target is NonNullable<Awaited<ReturnType<typeof targetOf>>> {
  if (!target) return false;
  if (!run.environmentSnapshot) return true;
  if (!target.repo || !target.department) return false;
  const scope = run.environmentSnapshot.description.repositoryScope;
  return scope.companyId === run.companyId && scope.repositoryOwnerId === target.department.id && scope.repoUrlHash === hashToken(target.repo.url);
}
export { WORK_MEMORY_GB, TEST_MINUTES, TEST_MINUTES_MAX, OPEN_RUNS, WAIT_MS, AWAY_MS, RERUNS } from './constants.js';
export { taskFor, logName } from './run-records.js';
