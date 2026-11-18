import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { people } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { machinePrincipal, withInputLock } from '../conversation/decision-context.js';
import { appendEvent, appendOutgoing } from '../events/store.js';
import { personParty } from '../events/parties.js';
import type { ToolJob } from '../tools/job.js';
import { logName, onMachine, RUN_DEFAULT_S, RUN_MAX_S, type AccessMachine, type AccessState, type Waited } from './access.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
type Said = ReturnType<typeof say>;

const NO_OWN = "The machine this server runs on has none of the company's core yet. Call machines for the ones that have.";
const noSuch = (name: string) => `There is no machine of the company with a core named ${name}. Call machines for their names.`;
const ambiguous = (name: string) => `More than one machine is called ${name}. Name it by its id from machines.`;
const unreachable = (name: string) => `Hornhoof cannot reach ${name} now: its core has not answered for a minute. Tell its owner in a line; never ask anyone to type commands.`;
const closed = (name: string, employee = false) => employee ? `Access to ${name} is not open to all company agents. Ask the orchestrator to request it from its owner, then go on once the owner opens all_agents.` : `Access to ${name} is closed. Ask its owner for it with ask_computer_access and the reason in a line, then go on once it opens.`;
const notTheirs = (owner: string, name: string) =>
  `The last words in this turn came from a person who may not direct commands on ${name}: only the CEO, the CEO delegate or ${owner}, who owns it, may. Nothing was run. Ask them first.`;

const MACHINE = z.string().trim().min(1).max(200).optional().describe('The machine, by its name or its id from machines. Left out: the machine the company server runs on.');

/* The machine the orchestrator named, or what it is told when there is no such one. */
async function named(ctx: Ctx, job: ToolJob, machine: string | undefined): Promise<AccessMachine | Said> {
  const found = await ctx.computer.find(job.companyId, machine);
  if (found === 'ambiguous') return say(ambiguous(machine ?? ''), true);
  if (found === 'none') return say(machine === undefined ? NO_OWN : noSuch(machine), true);
  return found;
}

const isSaid = (value: AccessMachine | Said): value is Said => 'content' in value;

async function ownerName(ctx: Ctx, personId: string): Promise<string> {
  const [owner] = await ctx.db.select(only(people, 'name')).from(people).where(eq(people.id, personId));
  return owner?.name ?? 'its owner';
}

/* What a wait for a command comes to, for the orchestrator. */
async function answer(ctx: Ctx, job: ToolJob, id: string, waited: Waited): Promise<Said> {
  if (waited === 'gone') return say('There is no such command: it was never made, or it ended more than a day ago. Look before you run it again.', true);
  const machine = await ctx.computer.machineOfRun(id, job.companyId, job.agentId);
  const name = machine?.name ?? 'the machine';
  if (waited === 'lost') return say(`The command's outcome is unknown: ${name}'s core lost it. Look at the machine before you run it again.`, true);
  if (waited === 'running') {
    if (machine && !ctx.computer.reachable(machine.id)) return say(`${name} does not answer now; the command's outcome is unknown until it does. Call computer_result with id ${id} later.`);
    return say(`Still running. Call computer_result with id ${id} for its result; each call waits up to ${Math.round(ctx.computer.waitMs / 1000)} seconds.`);
  }
  return say(`Exit code ${waited.exit}.\n${waited.output}`);
}

/* A command starts only while the machine's grant allows it. A head or worker also needs an allowed speaker. */
async function started(ctx: Ctx, job: ToolJob, machine: AccessMachine, command: string, seconds: number): Promise<{ id: string } | Said> {
  const run = async () => {
    if (!(await ctx.computer.openUntil(machine.id, job.agentKind))) return say(closed(machine.name, job.agentKind !== 'orchestrator'), true);
    if (job.agentKind !== 'orchestrator' && !(await machinePrincipal(ctx.db, job.id, machine.personId, machine.id))) {
      return say(notTheirs(await ownerName(ctx, machine.personId), machine.name), true);
    }
    if (!ctx.computer.reachable(machine.id)) return say(unreachable(machine.name), true);
    const started = await ctx.computer.start(job, machine.id, command, seconds);
    if (started === 'closed') return say(closed(machine.name, job.agentKind !== 'orchestrator'), true);
    return started === 'none' ? say(noSuch(machine.name), true) : started;
  };
  return job.agentKind === 'orchestrator' ? run() : withInputLock(ctx, job.agentId, run);
}

/* One machine in a line, for the orchestrator. */
function lineOf(state: AccessState, owner: string): string {
  const { machine } = state;
  const access = state.until ? `access open to ${state.scope} until ${state.until}` : state.asked ? `asked: ${state.asked.reason}` : 'closed';
  return [
    `${machine.name} (${machine.id})`,
    machine.role ?? 'no role',
    `owner ${owner}`,
    machine.os ?? 'unknown',
    ...(machine.data ? ["holds the company's data"] : []),
    state.reachable ? 'reachable' : 'not answering',
    access,
    ...(state.key === 'not_held' ? ['its owner must give it their key first (its card says how)'] : []),
  ].join(', ');
}

/* Asking an owner is available only to the orchestrator; employees use the command tools. */
function registerAccessRequest(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'ask_computer_access',
    {
      description:
        'Asks the owner of a machine of the company for access to it for the duration its owner chooses, when a fix needs the machine itself: Docker, the system, files outside Hornhoof. ' +
        'The owner sees the reason and opens it with one click; then you get a note and go on by yourself. Never ask anyone to type commands.',
      inputSchema: { machine: MACHINE, reason: z.string().trim().min(1).max(500).describe('What you need the machine for, in a line.') },
    },
    async ({ machine: asked, reason }) => {
      const machine = await named(ctx, job, asked);
      if (isSaid(machine)) return machine;
      if (!ctx.computer.reachable(machine.id)) return say(unreachable(machine.name), true);
      const until = await ctx.computer.openUntil(machine.id);
      if (until) return say(`Access to ${machine.name} is open until ${until}. Use computer with machine ${machine.id}.`);
      await ctx.computer.ask(job.companyId, machine.id, reason);
      ctx.bus.publish(job.companyId, { type: 'computer' });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'computer', data: { state: 'asked', reason, ...onMachine(logName(machine)) } });
      await appendOutgoing(ctx, { ...job, jobId: job.id, text: reason, to: await personParty(ctx, job.companyId, machine.personId) });
      const state = (await ctx.computer.states(job.companyId)).find(one => one.machine.id === machine.id);
      const keyless = state?.key === 'not_held' ? ` ${machine.name} does not hold their key yet, and its card tells them what to do. Do not tell anyone to type commands.` : '';
      return say(
        `The owner of ${machine.name}, ${await ownerName(ctx, machine.personId)}, sees your request and opens access with one click. You get a note then and go on; until then go on with other work or end your turn.${keyless}`,
      );
    },
  );
}

/* A machine's grant opens it to the orchestrator, or to company agents as a group. */
export function registerComputerTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'machines',
    {
      description:
        "Lists the company's machines that have its core: name, id, role, owner, system, whether it holds the company's data, whether Hornhoof reaches it, and its computer access. " +
        'Computer access is per machine, and only each machine\'s owner opens it, with their own key.',
      inputSchema: {},
    },
    async () => {
      const states = await ctx.computer.states(job.companyId);
      if (states.length === 0) return say("No machine of the company has its core yet, so there is no computer access to ask for.");
      const owners = await ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, [...new Set(states.map(state => state.machine.personId))]));
      const names = new Map(owners.map(owner => [owner.id, owner.name]));
      return say(states.map(state => lineOf(state, names.get(state.machine.personId) ?? 'unknown')).join('\n'));
    },
  );

  if (job.agentKind === 'orchestrator') registerAccessRequest(server, ctx, job);

  server.registerTool(
    'computer',
    {
      _meta: { secretCommand: true },
      description:
        'Runs a bash command as root on a machine of the company, while its owner keeps access to it open, and gives back its exit code and the end of its output. ' +
        (job.agentKind === 'orchestrator'
          ? 'The grant applies in any turn and in tool steps between turns. '
          : "A department agent also needs a turn whose speaker may direct commands on that machine. ") +
        "It runs in a helper container with every privilege, in the machine's processes and network: docker reaches the machine's Docker, the machine's files are at /host, " +
        "and chroot /host sh -c '...' runs a command on the machine itself (Linux; on a Mac the machine is Docker's own Linux system). Commands get no input, so pass -y and the like. " +
        'A command that takes longer than a tool call answers that it still runs, with an id for computer_result. Look before you change anything, and say in your answer what you ran, where and why.',
      inputSchema: {
        machine: MACHINE,
        command: z.string().min(1).max(20_000).describe('The bash command.'),
        timeoutSeconds: z.number().int().min(1).max(RUN_MAX_S).optional().describe(`How long it may run, ${RUN_DEFAULT_S} when left out.`),
      },
    },
    async ({ machine: asked, command, timeoutSeconds }) => {
      const machine = await named(ctx, job, asked);
      if (isSaid(machine)) return machine;
      const run = await started(ctx, job, machine, command, timeoutSeconds ?? RUN_DEFAULT_S);
      return 'id' in run ? answer(ctx, job, run.id, await ctx.computer.wait(run.id, job.companyId, job.agentId)) : run;
    },
  );

  server.registerTool(
    'computer_result',
    {
      description: 'Waits for the result of a command that computer said still runs, and gives back its exit code and the end of its output once it ended.',
      inputSchema: { id: z.uuid().describe('The id computer gave.') },
    },
    async ({ id }) => answer(ctx, job, id, await ctx.computer.wait(id, job.companyId, job.agentId)),
  );
}
