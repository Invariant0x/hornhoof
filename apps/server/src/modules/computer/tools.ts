import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { computerPrincipal, withInputLock } from '../conversation/decision-context.js';
import { appendEvent, appendOutgoing } from '../events/store.js';
import { personParty } from '../events/parties.js';
import { decisionPerson } from '../tasks/decisions.js';
import { ONLY_CEO } from '../tools/control.js';
import type { ToolJob } from '../tools/job.js';
import { onMachine, RUN_DEFAULT_S, RUN_MAX_S, serverMachine, type Waited } from './access.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const UNREACHABLE = "Hornhoof cannot reach the computer it runs on: its updater does not run there. Tell the CEO in a line that running Hornhoof's install command on that computer again brings it back.";
const CLOSED = 'Access to the computer is closed. Ask the CEO for it with ask_computer_access and the reason in a line, then go on once it opens.';

/* What a wait for a command comes to, for the orchestrator. */
function answer(id: string, waited: Waited, seconds: number) {
  if (waited === 'gone') return say('The updater has no such command: its answer was taken already, or it was forgotten. Look before you run it again.', true);
  if (waited === 'running') return say(`Still running. Call computer_result with id ${id} for its result; each call waits up to ${seconds} seconds.`);
  return say(`Exit code ${waited.exit}.\n${waited.output}`);
}

/* A command starts only in a turn that answers the CEO or the CEO delegate now, or that their click opening the computer
   opened, kept under the input lock from words that would change it meanwhile, and while access is open: its id, or why
   it did not start. */
function started(ctx: Ctx, job: ToolJob, command: string, seconds: number) {
  return withInputLock(ctx, job.agentId, async () => {
    if (!(await computerPrincipal(ctx.db, job.id))) return say(ONLY_CEO, true);
    if (!ctx.computer.openUntil()) return say(CLOSED, true);
    if (!ctx.computer.available()) return say(UNREACHABLE, true);
    return ctx.computer.start(command, seconds);
  });
}

/* The orchestrator's way out of its container: it asks the CEO for the computer the server runs on, and while the CEO
   keeps access open it runs commands there as root, in turns that answer the CEO. */
export function registerComputerTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'ask_computer_access',
    {
      description:
        'Asks the CEO for access to the computer the server runs on, for a day, when a fix needs the computer itself: Docker, the system, files outside Hornhoof. ' +
        'The CEO sees the reason in your window and opens it with one click; then you get a note and go on by yourself. Never ask the CEO to type commands.',
      inputSchema: { reason: z.string().trim().min(1).max(500).describe('What you need the computer for, in a line.') },
    },
    async ({ reason }) => {
      if (!ctx.computer.available()) return say(UNREACHABLE, true);
      const until = ctx.computer.openUntil();
      if (until) return say(`Access to the computer is open until ${until}. Use computer.`);
      ctx.computer.ask(reason);
      ctx.bus.publish(job.companyId, { type: 'computer' });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'computer', data: { state: 'asked', reason, ...onMachine(await serverMachine(ctx, job.companyId)) } });
      const personId = await decisionPerson(ctx, job.companyId, { source: 'computer_access' });
      await appendOutgoing(ctx, { ...job, jobId: job.id, text: reason, to: await personParty(ctx, job.companyId, personId) });
      return say('The CEO sees your request in your window and opens access with one click. You get a note then and go on; until then go on with other work or end your turn.');
    },
  );

  server.registerTool(
    'computer',
    {
      description:
        'Runs a bash command as root on the computer the server runs on, while the CEO keeps access open, and gives back its exit code and the end of its output. ' +
        "It runs in a helper container with every privilege, in the computer's processes and network: docker reaches the computer's Docker, the computer's files are at /host, " +
        "and chroot /host sh -c '...' runs a command on the computer itself (Linux; on a Mac the computer is Docker's own Linux system). Commands get no input, so pass -y and the like. " +
        'A command that takes longer than a tool call answers that it still runs, with an id for computer_result. Look before you change anything, and say in your answer what you ran and why.',
      inputSchema: {
        command: z.string().min(1).max(20_000).describe('The bash command.'),
        timeoutSeconds: z.number().int().min(1).max(RUN_MAX_S).optional().describe(`How long it may run, ${RUN_DEFAULT_S} when left out.`),
      },
    },
    async ({ command, timeoutSeconds }) => {
      const id = await started(ctx, job, command, timeoutSeconds ?? RUN_DEFAULT_S);
      return typeof id === 'string' ? answer(id, await ctx.computer.wait(id), Math.round(ctx.computer.waitMs / 1000)) : id;
    },
  );

  server.registerTool(
    'computer_result',
    {
      description: 'Waits for the result of a command that computer said still runs, and gives back its exit code and the end of its output once it ended.',
      inputSchema: { id: z.uuid().describe('The id computer gave.') },
    },
    async ({ id }) => answer(id, await ctx.computer.wait(id), Math.round(ctx.computer.waitMs / 1000)),
  );
}
