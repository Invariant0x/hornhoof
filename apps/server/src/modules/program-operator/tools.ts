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
    description: "See the program of any employee, of any department, plan or machine, as it is now: a picture, its text, whether it works or stands, the tool it runs, the question it asks (the subscription owner's own too), what its input line holds (empty, words Hornhoof typed, words a person typed, unreadable) and whether words Hornhoof gave it never went in. Only the values of secrets are masked. It opens no program. The snapshot it returns takes one program_keys within 30 seconds.",
    inputSchema: { employee: z.uuid() },
  }, input => checked(async () => {
    const { png, ...view } = await readProgramView(ctx, caller, input);
    return { content: [...text(view).content, { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') }] };
  }));
  server.registerTool('program_keys', {
    description: 'Type into the program a fresh program_screen showed, as a person at its terminal would. text goes in first as a paste, then keys one after another, by their tmux names: Enter, Escape, Tab, BSpace, Up, Down, PageUp, a letter, C-u to clear the input line, C-c, M-b. Any key, any text, and any question answered, the owner\'s own too. Give a reason; on a permission question say decision allowed or denied. Hornhoof writes who, why, the keys and the text with secrets masked in the employee\'s log. A lost result is unknown and is never sent again: look again before you repeat it.',
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
  server.registerTool('tell_orchestrator', { description: "Report your program case once with its picture. cleared closes it and goes to no one, once a fresh program_screen shows the program at work with no question; Hornhoof looks again and refuses it otherwise. needs_owner and failed go to the orchestrator; denied after a permission denial goes to the target department head, or the orchestrator when no head exists. Hornhoof supplies the picture. A case that closed already answers how it closed, and your report changes nothing.", inputSchema: { case: z.uuid(), outcome: z.enum(['cleared', 'needs_owner', 'failed', 'denied']), text: z.string().trim().min(1).max(4000) } }, input => checked(async () => text(await reportOperatorCase(ctx, caller, input))));
}
