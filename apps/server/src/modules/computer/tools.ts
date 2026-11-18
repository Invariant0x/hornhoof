import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { people } from '../../db/schema.js';
import { TaskReference } from '../tasks/external-wait.js';
import type { ToolJob } from '../tools/job.js';
import { closedLine, logName, onMachine, RUN_DEFAULT_S, RUN_MAX_S, type AccessMachine, type AccessState, type Waited } from './access.js';
import { computerLine } from './events.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
type Said = ReturnType<typeof say>;

const NO_OWN = "The machine this server runs on has none of the company's core yet. Call machines for the ones that have.";
const noSuch = (name: string) => `There is no machine of the company with a core named ${name}. Call machines for their names.`;
const ambiguous = (name: string) => `More than one machine is called ${name}. Name it by its id from machines.`;
const unreachable = (name: string) => `Hornhoof cannot reach ${name} now. Check machines for its connection.`;

const MACHINE = z.string().trim().min(1).max(200).optional().describe('The machine, by its name or its id from machines. Left out: the machine the company server runs on.');

/* The machine the orchestrator named, or what it is told when there is no such one. */
async function named(ctx: Ctx, job: ToolJob, machine: string | undefined): Promise<AccessMachine | Said> {
  const found = await ctx.computer.find(job.companyId, machine);
  if (found === 'ambiguous') return say(ambiguous(machine ?? ''), true);
  if (found === 'none') return say(machine === undefined ? NO_OWN : noSuch(machine), true);
  return found;
}

const isSaid = (value: AccessMachine | Said): value is Said => 'content' in value;

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

async function started(ctx: Ctx, job: ToolJob, machine: AccessMachine, command: string, seconds: number): Promise<{ id: string } | Said> {
  const run = await ctx.computer.start(job, machine.id, command, seconds);
  if (run === 'closed') return say(closedLine(machine.name), true);
  if (run === 'not_granted') return say(`The orchestrator has not opened access to ${machine.name} for you on this task.`, true);
  if (run === 'unreachable') return say(unreachable(machine.name), true);
  return run === 'none' ? say(noSuch(machine.name), true) : run;
}

/* One machine in a line, for the orchestrator. */
function lineOf(state: AccessState, owner: string): string {
  const { machine } = state;
  const access = state.open ? `access open to ${state.scope}` : 'owner closed access';
  const grants = state.employees.map(grant => `employee ${grant.employeeId} on task ${grant.taskId}`);
  return [
    `${machine.name} (${machine.id})`,
    machine.role ?? 'no role',
    `owner ${owner}`,
    machine.os ?? 'unknown',
    ...(machine.data ? ["holds the company's data"] : []),
    state.reachable ? 'reachable' : 'not answering',
    access,
    ...grants,
  ].join(', ');
}

function registerDelegation(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'open_computer_access',
    {
      description: 'Gives computer access on a connected machine to all company employees, or to one named employee on a task. Use revoke to withdraw it when the work ends. Access has no time limit. The machine owner can close the machine to everyone.',
      inputSchema: {
        machine: MACHINE,
        allAgents: z.literal(true).optional().describe('Give access to all company employees. Leave employee and task out.'),
        employee: z.uuid().optional().describe("The employee's id from company."),
        task: TaskReference.optional(),
        revoke: z.boolean().optional().describe('Withdraw the specified access.'),
      },
    },
    async ({ machine: asked, allAgents, employee, task, revoke = false }) => {
      const to = allAgents && employee === undefined && task === undefined ? { allAgents } : !allAgents && employee && task !== undefined ? { employee, task } : null;
      if (!to) return say('Choose allAgents, or give both employee and task.', true);
      const machine = await named(ctx, job, asked);
      if (isSaid(machine)) return machine;
      await ctx.computer.delegate(job, machine.id, to, revoke);
      ctx.bus.publish(job.companyId, { type: 'computer' });
      await computerLine(ctx, job.companyId, { state: revoke ? 'revoked' : 'delegated', ...to, ...onMachine(logName(machine)) }, null);
      return say(revoke ? `Withdrew the specified employee access to ${machine.name}.` : `Opened the specified employee access to ${machine.name}.`);
    },
  );
}

export function registerComputerTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'machines',
    {
      description:
        "Lists the company's machines that have its core: name, id, role, owner, system, whether it holds the company's data, whether Hornhoof reaches it, and its computer access. " +
        'The orchestrator has standing access and can delegate it to employees. Each owner can close their machine.',
      inputSchema: {},
    },
    async () => {
      const states = await ctx.computer.states(job.companyId);
      if (states.length === 0) return say("No machine of the company has its core yet, so there is no computer access yet.");
      const owners = await ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, [...new Set(states.map(state => state.machine.personId))]));
      const names = new Map(owners.map(owner => [owner.id, owner.name]));
      return say(states.map(state => lineOf(state, names.get(state.machine.personId) ?? 'unknown')).join('\n'));
    },
  );

  if (job.agentKind === 'orchestrator') registerDelegation(server, ctx, job);

  server.registerTool(
    'computer',
    {
      _meta: { secretCommand: true },
      description:
        'Runs a bash command as root on a connected machine and gives back its exit code and the end of its output. ' +
        (job.agentKind === 'orchestrator'
          ? 'Standing access applies in any turn and tool step while the machine owner keeps it open. '
          : 'Use the access the orchestrator gave you for this task or for all company employees. ') +
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
