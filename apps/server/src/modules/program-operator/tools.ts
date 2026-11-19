import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROGRAM_INPUT_KEYS, PROGRAM_INPUT_TEXT } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { readProgramView, sendProgramInput } from './access.js';
import type { OperatorCaller } from './authorization.js';
import { reportOperatorCase } from './reports.js';
import { stopEmployeeTurn } from './stop.js';

export { readProgramView, sendProgramInput, reportOperatorCase };
const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });

async function checked<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) { if (error instanceof ApiError) return text(error.message, true); throw error; }
}

/* The orchestrator's and Operations' look at any employee's program, and their hands on it. */
export function registerProgramAccessTools(server: McpServer, ctx: Ctx, caller: OperatorCaller): void {
  server.registerTool('program_screen', {
    description: 'Read another employee’s existing program screen: image, visible text, activity, open question and input line state. Secret values are masked. For your own program or a personal assistant, use its own recovery path. Use the returned snapshot once with program_keys while it is fresh.',
    inputSchema: { employee: z.uuid() },
  }, input => checked(async () => {
    const { png, ...view } = await readProgramView(ctx, caller, input);
    return { content: [...text(view).content, { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') }] };
  }));
  server.registerTool('program_keys', {
    description: 'Type into the program shown by a fresh program_screen. The tool pastes text first and then sends the keys. Give a reason and record allowed or denied when you decide a permission question. Ask the account holder for their personal consent or terms when required. A person makes payments and signs for the company. Use vault values only in protected sign-in fields. After a lost result, inspect the screen before acting again.',
    inputSchema: { employee: z.uuid(), snapshot: z.string().min(16).max(128), keys: z.array(z.string().min(1).max(40)).max(PROGRAM_INPUT_KEYS).optional(), text: z.string().min(1).max(PROGRAM_INPUT_TEXT).optional(), reason: z.string().trim().min(1).max(1000), decision: z.enum(['allowed', 'denied']).optional() },
  }, input => checked(async () => text(await sendProgramInput(ctx, caller, input))));
}

/* Operations' own stop of a turn that stands. The orchestrator has its own stop_employee among its controls. */
export function registerStopTool(server: McpServer, ctx: Ctx, caller: OperatorCaller): void {
  server.registerTool('stop_employee', {
    description: 'Stop the turn any employee of the company runs now, the orchestrator and any head too, as Esc in its window does. Nobody is fired or switched off: its next turn starts from its queue. Look at program_screen first. Say why: who stopped whom and why goes in the log of the turn it ends.',
    inputSchema: { employee: z.uuid(), reason: z.string().trim().min(1).max(500) },
  }, input => checked(async () => text(await stopEmployeeTurn(ctx, caller, input))));
}

/* The program operator's report of the case it was given. */
export function registerOperatorTools(server: McpServer, ctx: Ctx, caller: OperatorCaller): void {
  server.registerTool('tell_orchestrator', { description: "Report your program case once with its picture. cleared closes it and goes to no one, once a fresh program_screen shows the program at work with no question; Hornhoof looks again and refuses it otherwise. needs_owner and failed go to the orchestrator; denied after your denial of a permission or protected question goes to the target department head, or the orchestrator when no head exists. Hornhoof supplies the picture. A case that closed already answers how it closed, and your report changes nothing.", inputSchema: { case: z.uuid(), outcome: z.enum(['cleared', 'needs_owner', 'failed', 'denied']), text: z.string().trim().min(1).max(4000) } }, input => checked(async () => text(await reportOperatorCase(ctx, caller, input))));
}
