import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { sendProgramKey } from './actions.js';
import type { OperatorCaller } from './authorization.js';
import { readProgramScreen } from './pictures.js';
import { reportOperatorCase } from './reports.js';

export { sendProgramKey, readProgramScreen, reportOperatorCase };
const target = { employee: z.uuid(), case: z.uuid() };
const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });

async function checked<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) { if (error instanceof ApiError) return text(error.message, true); throw error; }
}

export function registerOperatorTools(server: McpServer, ctx: Ctx, caller: OperatorCaller): void {
  server.registerTool('program_screen', { description: 'Read the existing agent program for your assigned case. Returns a masked PNG and a fresh snapshot for one key. No login terminal or new program is opened.', inputSchema: target }, input => checked(async () => {
    const { png, ...screen } = await readProgramScreen(ctx, caller, input);
    return { content: [...text(screen).content, { type: 'image' as const, mimeType: 'image/png', data: png.toString('base64') }] };
  }));
  server.registerTool('program_keys', { description: 'Press exactly one of Enter, Up, Down, Left, Right, Tab after a fresh program_screen. Give a reason. On Enter for a permission question, state decision allowed or denied; Hornhoof records the exact question and actor. A lost result is unknown and is never retried automatically. Escape, control keys, text and working programs are refused.', inputSchema: { ...target, snapshot: z.uuid(), key: z.string().min(1).max(40), reason: z.string().trim().min(1).max(1000), decision: z.enum(['allowed', 'denied']).optional(), action: z.uuid().optional() } }, input => checked(async () => text(await sendProgramKey(ctx, caller, input))));
  server.registerTool('tell_orchestrator', { description: 'Report your program case once with its picture. needs_owner and failed go to the orchestrator; denied after a permission denial goes to the target department head, or the orchestrator when no head exists. Hornhoof supplies the picture.', inputSchema: { case: z.uuid(), outcome: z.enum(['needs_owner', 'failed', 'denied']), text: z.string().trim().min(1).max(4000) } }, input => checked(async () => text(await reportOperatorCase(ctx, caller, input))));
}
